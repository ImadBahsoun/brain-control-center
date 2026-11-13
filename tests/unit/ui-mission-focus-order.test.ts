// Regression test: drives selectFocus + nextAutoFocus in the exact render order use-mission-view.ts
// uses them (selectFocus during render, nextAutoFocus afterwards in a useEffect, fed back as `auto.current`
// on the next render). This exposes a bug that calling each function in isolation (as mission.test.ts does)
// does not: on the very poll where the auto-focused mission turns terminal, `auto.current` from the PRIOR
// render is still the plain `{id, active:true}` (no `hold` yet) nextAutoFocus wrote while it was active.
// selectFocus's `held` check (`previous.active && previous.hold !== undefined`) is false for that shape, so
// if another mission is live, selectFocus jumps focus straight to it — before nextAutoFocus ever gets a
// chance to start the terminal hold for the mission that just finished. The READY / mission-complete hold
// described in src/lib/ui/mission.ts (nextAutoFocus's doc comment, "held until its terminal detail was
// shown") is silently skipped.
import { describe, expect, it } from "vitest";
import type { TaskSummary } from "@/lib/api-types";
import { nextAutoFocus, selectFocus, type AutoFocus } from "@/lib/ui/mission";

const NOW0 = "2026-10-12T14:20:00.000Z";
function minutesAgo(min: number, from = NOW0): string {
  return new Date(Date.parse(from) - min * 60_000).toISOString();
}

function mkTask(overrides: Partial<TaskSummary> & Pick<TaskSummary, "id">): TaskSummary {
  return {
    title: null,
    classification: null,
    state: null,
    round: 0,
    maxRounds: 2,
    status: "ACTIVE",
    active: true,
    blocked: false,
    ready: false,
    waitingApproval: false,
    createdAt: null,
    updatedAt: null,
    lastEventAt: minutesAgo(5),
    eventCount: 1,
    findings: { total: 0, open: 0, openBySeverity: { BLOCKER: 0, MAJOR: 0, MINOR: 0, NIT: 0 } },
    topOpenFindings: [],
    pendingRuns: 0,
    summaryUnavailable: false,
    integrity: { log: "ok", chainChecked: false, cache: "fresh", logSeq: 1, cacheSeq: 1 },
    repository: null,
    parentTaskId: null,
    parentStepId: null,
    ...overrides,
  };
}

/** One render of use-mission-view.ts's focus logic: selectFocus(list, chosenId, auto, now) during render,
 * then nextAutoFocus(...) in the effect that follows, fed the SAME render's selectFocus result as focusId
 * and the (possibly stale) `auto` as `previous` — exactly the order the hook runs them in. */
function renderOnce(auto: AutoFocus | null, tasks: TaskSummary[], now: string, tasksStamp: string, detailForFocus: null = null): { focusId: string | null; nextAuto: AutoFocus | null } {
  const focusId = selectFocus(tasks, null, auto, now);
  const summary = tasks.find((t) => t.id === focusId) ?? null;
  const nextAuto = nextAutoFocus(auto, { focusId, chosenId: null, summary, detail: detailForFocus, tasksStamp });
  return { focusId, nextAuto };
}

describe("selectFocus + nextAutoFocus driven in the hook's actual render order", () => {
  it("holds the focused mission through the poll it turns terminal, even though another mission is live", () => {
    const A_running = mkTask({ id: "A", status: "ACTIVE", lastEventAt: minutesAgo(1) }); // newer: picked first
    const B_running = mkTask({ id: "B", status: "ACTIVE", lastEventAt: minutesAgo(10) });

    // poll 1: both running, A is newest -> auto focus lands on A
    let auto: AutoFocus | null = null;
    let r = renderOnce(auto, [A_running, B_running], NOW0, "t1");
    expect(r.focusId).toBe("A");
    auto = r.nextAuto;
    expect(auto).toEqual({ id: "A", active: true });

    // poll 2: A turns terminal (COMPLETE) in the same render that observes it; B is still live.
    const A_done = mkTask({ id: "A", status: "COMPLETE", active: false, lastEventAt: minutesAgo(1) });
    const NOW1 = minutesAgo(-1); // a little later than NOW0
    r = renderOnce(auto, [A_done, B_running], NOW1, "t2");

    // The mission strip / command-map hold contract (nextAutoFocus's doc comment, and the existing
    // "keeps the terminal hold" test in ui-mission.test.ts) requires the just-completed mission to stay
    // focused for at least this render, so its READY / mission-complete detail can be shown — exactly as
    // it would if `auto.current` already carried a `hold` (see mission.test.ts: "keeps the terminal hold
    // (nextAutoFocus's hold) even though a different mission is genuinely live"). Because selectFocus runs
    // BEFORE nextAutoFocus ever attaches that hold, this is expected to fail on the current code: focus
    // jumps straight to B instead.
    expect(r.focusId).toBe("A");
  });

  it("holds A through the terminal transition poll, then through nextAutoFocus's own hold, then releases it to the other live mission B", () => {
    const A_running = mkTask({ id: "A", status: "ACTIVE", lastEventAt: minutesAgo(1) });
    const B_running = mkTask({ id: "B", status: "ACTIVE", lastEventAt: minutesAgo(10) });
    const A_done = mkTask({ id: "A", status: "COMPLETE", active: false, lastEventAt: minutesAgo(1) });

    // poll 1: A is freshly auto-focused (no hold yet)
    let auto: AutoFocus | null = null;
    let r = renderOnce(auto, [A_running, B_running], NOW0, "t1");
    expect(r.focusId).toBe("A");
    auto = r.nextAuto;
    expect(auto).toEqual({ id: "A", active: true });

    // poll 2: A turns terminal. selectFocus still returns A (the fix), and nextAutoFocus starts the hold.
    r = renderOnce(auto, [A_done, B_running], NOW0, "t2");
    expect(r.focusId).toBe("A");
    auto = r.nextAuto;
    expect(auto).toMatchObject({ id: "A", active: true, hold: { seen: false, polls: 0 } });

    // polls 3 and 4: the hold itself (previous.hold is now set) keeps A focused while B stays live.
    r = renderOnce(auto, [A_done, B_running], NOW0, "t3");
    expect(r.focusId).toBe("A");
    auto = r.nextAuto;
    expect(auto).toMatchObject({ id: "A", active: true, hold: { polls: 1 } });

    r = renderOnce(auto, [A_done, B_running], NOW0, "t4");
    expect(r.focusId).toBe("A");
    auto = r.nextAuto;
    expect(auto).toMatchObject({ id: "A", active: true, hold: { polls: 2 } });

    // poll 5: HOLD_MAX_POLLS (3) distinct polls since the hold began releases it, even with no terminal
    // detail ever seen; nextAutoFocus hands back {active: false}, and the next render's selectFocus moves
    // on to the other live mission.
    r = renderOnce(auto, [A_done, B_running], NOW0, "t5");
    expect(r.focusId).toBe("A"); // this render still shows A: the release is observed by the NEXT render
    auto = r.nextAuto;
    expect(auto).toEqual({ id: "A", active: false });

    r = renderOnce(auto, [A_done, B_running], NOW0, "t6");
    expect(r.focusId).toBe("B");
  });
});
