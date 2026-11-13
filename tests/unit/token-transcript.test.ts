import { describe, expect, it } from "vitest";
import { LineExtractor } from "@/server/tokens/transcript";

function readToolUseLine(toolUseId: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-10-14T08:00:00Z",
      isMeta: false,
      // no message.id: isolates pendingReads growth from the calls map
      message: { model: "claude-sonnet-5", usage: {}, content: [{ type: "tool_use", id: toolUseId, name: "Read", input: { file_path: "/x/orchestration/SKILL.md" } }] },
    }),
  );
}

function toolResultLine(toolUseId: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: "user",
      timestamp: "2026-10-14T08:00:01Z",
      isMeta: false,
      message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] },
    }),
  );
}

describe("S2/S4: pendingReads is bounded by the same per-file cap as every other record", () => {
  it("stops growing at maxRecords and counts every further unique id as overflow", () => {
    const cap = 50;
    const extractor = new LineExtractor(cap);
    for (let i = 0; i < 1000; i++) extractor.process(readToolUseLine(`tu-${i}`));
    // none of these ever resolve, so every successful one stays pending; growth must stop exactly at cap
    expect(extractor.recordsOverflowed).toBe(1000 - cap);
    expect(extractor.instructionReads).toHaveLength(0);
  });

  it("a crafted file with millions of unanswered tool_use ids never grows past the cap (security PoC shape)", () => {
    const cap = 1000;
    const extractor = new LineExtractor(cap);
    for (let i = 0; i < 2_000_000; i++) extractor.process(readToolUseLine(`tu-${i}`));
    // before the fix this was 0 (unbounded growth); now every id past the cap is counted
    expect(extractor.recordsOverflowed).toBe(2_000_000 - cap);
  });

  it("deletes a pending entry once resolved, so a second (duplicate) tool_result for the same id is a no-op", () => {
    const extractor = new LineExtractor(100);
    extractor.process(readToolUseLine("tu-0"));
    extractor.process(toolResultLine("tu-0"));
    expect(extractor.instructionReads).toHaveLength(1);

    // if the pending entry were left behind (not deleted), this second, duplicate tool_result for the
    // same id would find it again and push a second instructionReads record
    extractor.process(toolResultLine("tu-0"));
    expect(extractor.instructionReads).toHaveLength(1);
  });
});
