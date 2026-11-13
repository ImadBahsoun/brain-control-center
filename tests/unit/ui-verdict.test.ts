import { describe, expect, it } from "vitest";
import { verdictTone } from "@/lib/ui/verdict";

describe("verdictTone over every verdict string seen in the real store and the fixtures", () => {
  it("passes", () => {
    for (const v of ["done", "PLAN_READY", "approve", "pass"]) expect(verdictTone(v), v).toBe("pass");
  });
  it("concerns come before pass, including partial or incomplete results", () => {
    for (const v of ["pass with concerns", "changes required", "approve with minor fixes", "blocked", "partially done", "done (incomplete)", "not fully done"]) expect(verdictTone(v), v).toBe("concern");
  });
  it("fails", () => {
    for (const v of ["fail", "failed", "FAIL: build broken"]) expect(verdictTone(v), v).toBe("fail");
    expect(verdictTone("done", "lost")).toBe("fail");
  });
  it("is neutral for unrecognised or missing verdicts, so the raw text is shown without a claim", () => {
    for (const v of ["not-launched", "", null, undefined, "something else"]) expect(verdictTone(v), String(v)).toBe("neutral");
  });
});
