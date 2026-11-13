import { describe, expect, it } from "vitest";
import { commanderGate } from "@/lib/ui/gate";
import { freshHome, highRiskScript, mkdirs, standardScript, writeGate, writeGovernor, writeScript } from "../helpers/fixture-store";
import { apiDetail, apiEvents, apiHealth } from "../helpers/ui-fixtures";

const ID = "BR-20261007-0001";

describe("commanderGate", () => {
  it("stopAfter 6: the plan gate is waiting with the request text and detail from the activity line", async () => {
    const home = freshHome();
    mkdirs(home);
    writeGovernor(home);
    writeGate(home, Date.now());
    writeScript(home, ID, highRiskScript(home, { stopAfter: 6 }));
    const g = commanderGate(await apiDetail(ID), await apiEvents(ID), await apiHealth());
    expect(g.active).toBe("plan");
    expect(g.plan).toMatchObject({ state: "action-required", label: "ACTION REQUIRED" });
    expect(g.human).toMatchObject({ state: "sealed", label: "SEALED" });
    expect(g.request).toMatchObject({ seq: 6, text: "Approval requested (plan)", detail: "approve the plan" });
    expect(g.requestOutsideWindow).toBe(false);
    expect(g.brainGate).toMatchObject({ status: "ok", pending: 1, pendingByAction: { commit: 1 } });
    expect(g.brainGate?.source).toContain("all tasks");
  });
  it("a PLAN_APPROVED line settles an open plan request even without APPROVAL_GRANTED", async () => {
    const home = freshHome();
    mkdirs(home);
    const specs = highRiskScript(home, { stopAfter: 6 });
    specs.push({ type: "PLAN_APPROVED", payload: { plan_seq: 5, approved: ["the plan"], not_approved: [] }, state: "IMPLEMENTING", next: "launch developer" });
    writeScript(home, ID, specs);
    const g = commanderGate(await apiDetail(ID), await apiEvents(ID), null);
    expect(g.active).toBeNull();
    expect(g.request).toBeNull();
    expect(g.plan.state).toBe("passed");
    expect(g.lastDecision?.type).toBe("PLAN_APPROVED");
  });
  it("a request of another kind stays open across a PLAN_APPROVED line", async () => {
    const home = freshHome();
    mkdirs(home);
    const specs = highRiskScript(home, { stopAfter: 5 });
    specs.push({ type: "APPROVAL_REQUESTED", payload: { kind: "release", what: "install it" }, state: "WAITING_FOR_APPROVAL" });
    specs.push({ type: "PLAN_APPROVED", payload: { plan_seq: 5, approved: ["the plan"], not_approved: [] } });
    writeScript(home, ID, specs);
    const g = commanderGate(await apiDetail(ID), await apiEvents(ID), null);
    expect(g.request).toMatchObject({ kind: "release", detail: "install it" });
  });
  it("after PLAN_APPROVED the plan gate has passed and the request is consumed", async () => {
    const home = freshHome();
    mkdirs(home);
    writeScript(home, ID, highRiskScript(home, { stopAfter: 8 }));
    const g = commanderGate(await apiDetail(ID), await apiEvents(ID), null);
    expect(g.active).toBeNull();
    expect(g.plan.state).toBe("passed");
    expect(g.request).toBeNull();
    expect(g.lastDecision?.type).toBe("PLAN_APPROVED");
    expect(g.planScope).toMatchObject({ approved: true, approvedScope: ["the plan", "deps"], notApproved: ["eslint"] });
    expect(g.brainGate).toBeNull();
  });
  it("the 40-event script raises the human gate; a complete mission has passed it", async () => {
    const home = freshHome();
    mkdirs(home);
    writeScript(home, ID, highRiskScript(home, { stopAfter: 40 }));
    const waiting = commanderGate(await apiDetail(ID), await apiEvents(ID), null);
    expect(waiting.active).toBe("human");
    expect(waiting.human.state).toBe("action-required");
    expect(waiting.plan.state).toBe("passed");
    expect(waiting.request).toBeNull(); // the only APPROVAL_REQUESTED line was granted at seq 7
    const other = freshHome();
    mkdirs(other);
    writeScript(other, ID, highRiskScript(other, { complete: true }));
    const done = commanderGate(await apiDetail(ID), await apiEvents(ID), null);
    expect(done.active).toBeNull();
    expect(done.human.state).toBe("passed");
  });
  it("a STANDARD mission needs no plan gate; a cancelled one seals the human gate as not required", async () => {
    const home = freshHome();
    mkdirs(home);
    writeScript(home, ID, standardScript(home, { cancelled: true }));
    const g = commanderGate(await apiDetail(ID), await apiEvents(ID), null);
    expect(g.plan.state).toBe("not-required");
    expect(g.human.state).toBe("not-required");
  });
  it("flags a request outside the loaded event window instead of inventing one", async () => {
    const home = freshHome();
    mkdirs(home);
    const specs = highRiskScript(home, { stopAfter: 6 });
    specs.push({ type: "NOTE", payload: { text: "still waiting" } }); // the state stays WAITING_FOR_APPROVAL
    writeScript(home, ID, specs);
    const detail = await apiDetail(ID);
    const g = commanderGate(detail, await apiEvents(ID, 1), null); // only the NOTE line is loaded
    expect(g.active).toBe("plan");
    expect(g.request).toBeNull();
    expect(g.requestOutsideWindow).toBe(true);
  });
  it("has no action: the model carries no approve field and nothing callable", async () => {
    const home = freshHome();
    mkdirs(home);
    writeScript(home, ID, highRiskScript(home, { stopAfter: 40 }));
    const g = commanderGate(await apiDetail(ID), await apiEvents(ID), null);
    for (const key of Object.keys(g)) expect(key).not.toMatch(/approve|grant|submit|action/i);
    expect(Object.values(g).some((v) => typeof v === "function")).toBe(false);
    expect(commanderGate(null, null, null)).toMatchObject({ active: null, plan: { state: "unknown" }, human: { state: "unknown" }, request: null });
  });
});
