"use client";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useFoldFocus } from "@/hooks/use-fold-state";
import type { MissionView } from "@/hooks/use-mission-view";
import { escapeExitsFocus } from "@/lib/ui/focus-mode";
import { railFolded, railWidths } from "@/lib/ui/fold-state";
import { currentAction } from "@/lib/ui/hud";
import { cn } from "@/lib/utils";
import { MissionFeed } from "@/components/events/mission-feed";
import { FocusHeader } from "@/components/map/focus-header";
import { LifecyclePath } from "@/components/map/lifecycle-path";
import { LiveAnnouncer } from "@/components/map/live-announcer";
import { MissionBar } from "@/components/map/mission-bar";
import { RecentMissions } from "@/components/map/recent-missions";
import { ReplayBar } from "@/components/map/replay-bar";
import { ResourceHud } from "@/components/map/resource-hud";
import { Glyph } from "@/components/ui/glyphs";
import { ThreatRail } from "@/components/map/threat-rail";
import { MapPanels } from "@/components/panels/map-panels";

/**
 * The mission view's frame, shared by the Command Map and the Office: mission bar, the left column (replay
 * controls, resource HUD, recent missions, feed), the scene pane, the threat rail, the lifecycle path, the
 * side panels and the live announcer. `scene` is what the scene pane draws. `sceneTools` (the Office's view
 * toggle) sits under the scene, a stable sibling in every mode and in Focus Mode. `variant="global"` (the
 * Global Office) hides the mission overlay, the replay-loading line and the lifecycle path, and offers no replay.
 */
export function MissionLayout({ view, scene, sceneTools, variant = "mission" }: { view: MissionView; scene: ReactNode; sceneTools?: ReactNode; variant?: "mission" | "global" }) {
  const { interval, tasks, list, chosenId, setChosenId, focusSummary, detail, findings, events, model, liveEffects, wide, selection, select, close, replay, toggleReplay, leaveReplay, replaying, shown, atmo, animated, feedEvents, selectedThreat, overlay, replayMessage, panelData, railChoice, setRailOpen, leftChoice, setLeftOpen, compactRail, reducedMotion, focus, setFocus } = view;
  // shared by the Mission Bar and the Focus Mode header, so both say the same thing about the same poll
  const stale = tasks.stale || detail.stale;
  const error = tasks.error ?? detail.error ?? (findings.error ? `findings: ${findings.error}` : null) ?? (replay.error ? `replay: ${replay.error}` : null);
  const generatedAt = tasks.data?.generatedAt ?? null;

  // showPath defaults on and keeps the viewer's choice for the page session (it is only reset by a fresh
  // page load, same as any other local state here); `focus` itself now lives in use-mission-view.ts, next
  // to `desktop`, so mapWheelMode (focus-mode.ts) can read both to pick the scene's wheel-zoom mode.
  const [showPath, setShowPath] = useState(true);
  const enterButtonRef = useRef<HTMLButtonElement>(null);
  const exitButtonRef = useRef<HTMLButtonElement>(null);
  // the focus value the move-focus effect last actually acted on; a plain "skip the first run" ref is
  // defeated by StrictMode's double-invoked mount effect (the second invocation sees the flag already
  // flipped and moves focus anyway), so this compares against the previous value instead
  const prevFocus = useRef(focus);
  // desktop folds (fold-state.ts): the left column defaults open; the rail's default depends on the width band
  const leftFolded = leftChoice === false;
  const railFold = railFolded(railChoice);
  const widths = railWidths({ compact: compactRail, choice: railChoice });
  const leftFocus = useFoldFocus(String(leftFolded));
  const foldLeft = (folded: boolean) => {
    leftFocus.request(folded);
    setLeftOpen(!folded);
  };

  // The root header (layout.tsx) is a server component, so Focus Mode hides it by hand: `hidden` keeps
  // it mounted but removes it from both rendering and the tab order. Restored on exit and on unmount.
  useEffect(() => {
    const header = document.getElementById("app-header");
    if (!header) return;
    header.hidden = focus;
    return () => {
      header.hidden = false;
    };
  }, [focus]);

  // Entering moves focus into the focus view (the Exit button); exiting returns it to the Focus mode
  // button. Only an actual change moves focus (not page load, and not StrictMode's synthetic re-run).
  useEffect(() => {
    if (prevFocus.current === focus) return;
    prevFocus.current = focus;
    if (focus) exitButtonRef.current?.focus();
    else enterButtonRef.current?.focus();
  }, [focus]);

  // Leaving a replay from the focus header restores focus the normal way (use-mission-view.ts), to the
  // Mission Bar's Replay button — but that button is `display:none` here, so a plain-element `.focus()`
  // on it is a no-op and this also moves focus to a control that is actually visible: Exit focus mode.
  const exitReplayInFocus = () => {
    leaveReplay();
    exitButtonRef.current?.focus();
  };

  // Esc exits Focus Mode, but defers to an open side panel's own Esc handling (use-panel-selection.ts):
  // see escapeExitsFocus for the full decision.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (escapeExitsFocus({ focusActive: focus, selectionOpen: selection != null, defaultPrevented: e.defaultPrevented })) setFocus(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, selection]);

  return (
    <>
      <div
        // ≥ 1440 px: 236 px left column and a 272 px rail (44 px with no findings), as before. 1100–1439 px: a
        // 200 px left column and the rail folded to its 44 px strip unless opened, so the map keeps its label size.
        // Either column can be folded to a 44 px strip at both widths (a remembered choice, fold-state.ts).
        // CSS-driven (no layout flash before hydration); the inline variables only carry the rail's state.
        // Focus Mode fills the viewport in a single column (fixed, above the page but below the side panels'
        // z-40) instead: FocusHeader is a new first child (its own fixed slot in this array, so toggling it
        // on/off never shifts any other child's position — `scene` below keeps its own slot either way), and
        // the rest of the grid's existing children are unchanged in the tree, only hidden or restyled.
        className={cn(
          "grid grid-cols-1 gap-2 p-2",
          focus
            ? // the fixed Focus Mode overlay sits under the device's notch/home-indicator insets, which are
              // 0 on desktop and in every browser without one; tailwind-merge keeps p-2 and these four
              // arbitrary side paddings together (different class groups), and the later ones win in the
              // generated CSS (see env(safe-area-inset-bottom) below, asserted by ui-static.test.ts)
              "fixed inset-0 z-30 grid-rows-[auto_minmax(0,1fr)_auto] overscroll-none bg-background pt-[max(0.5rem,env(safe-area-inset-top))] pr-[max(0.5rem,env(safe-area-inset-right))] pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(0.5rem,env(safe-area-inset-left))]"
            : "min-h-[calc(100dvh-44px)] min-[1100px]:h-[calc(100dvh-44px)] min-[1100px]:grid-cols-[var(--left-w)_minmax(0,1fr)_var(--rail-w)] min-[1100px]:grid-rows-[auto_minmax(0,1fr)_auto] min-[1100px]:[--rail-w:var(--rail-band)] min-[1440px]:[--rail-w:var(--rail-wide)]",
          !focus && (leftFolded ? "min-[1100px]:[--left-w:44px]" : "min-[1100px]:[--left-w:200px] min-[1440px]:[--left-w:236px]"),
        )}
        style={{ "--rail-wide": widths.wide, "--rail-band": widths.band } as CSSProperties}
      >
        {focus && (
          <FocusHeader
            model={shown}
            tasks={list ?? []}
            stale={stale}
            error={error}
            generatedAt={generatedAt}
            replaying={replaying}
            replay={replay}
            onExitReplay={exitReplayInFocus}
            showPath={showPath}
            onToggleShowPath={() => setShowPath((v) => !v)}
            showPathToggle={variant !== "global"}
            onExit={() => setFocus(false)}
            exitButtonRef={exitButtonRef}
          />
        )}
        <div className={cn("min-[1100px]:col-span-3", focus && "hidden")}>
          <MissionBar
            model={shown}
            tasks={list ?? []}
            chosenId={chosenId}
            onChoose={setChosenId}
            pollingText={`poll ${interval / 1000}s`}
            stale={stale}
            error={error}
            generatedAt={generatedAt}
            onReview={(el) => select({ kind: "gate" }, el)}
            onReplay={toggleReplay}
            replayAvailable={variant !== "global" && replay.available && model.mode === "debrief"}
            replayActive={replay.open}
            eta={replaying ? null : (focusSummary?.eta ?? null)}
          />
        </div>
        <div className={cn("order-2 flex min-h-0 flex-col min-[1100px]:order-none", focus && "hidden")}>
          {leftFolded && (
            <section className="hud hidden min-h-0 flex-1 flex-col min-[1100px]:flex" aria-label="Resources, recent missions and feed, folded">
              <button
                ref={leftFocus.showButton}
                type="button"
                className="row-button flex flex-1 flex-col items-center gap-3 px-1 py-3"
                onClick={() => foldLeft(false)}
                aria-expanded={false}
                aria-label="Show the resources, recent missions and feed column"
              >
                <span className="hud-title rail-vertical">Resources · Feed</span>
                <Glyph name="chevron" size={12} className="text-dim" />
              </button>
            </section>
          )}
          {/* the left column scrolls on short windows instead of running into the mission path */}
          <div className={cn("scroll-thin flex min-h-0 flex-1 flex-col gap-2 min-[1100px]:overflow-y-auto", leftFolded && "min-[1100px]:hidden")}>
            <button ref={leftFocus.hideButton} type="button" className="btn hidden shrink-0 self-end py-0.5 min-[1100px]:inline-flex" onClick={() => foldLeft(true)} aria-expanded aria-label="Hide the resources, recent missions and feed column">
              Hide
            </button>
            {/* the replay controls sit in this column so the map keeps its size (labels stay ≥ 11 px) */}
            {replaying && <ReplayBar replay={replay} onExit={leaveReplay} />}
            <ResourceHud resources={model.resources} replay={replaying} />
            <RecentMissions tasks={list} focusId={chosenId} onChoose={setChosenId} className="min-h-0 shrink-0" />
            <MissionFeed events={feedEvents} detail={shown.detail} missionId={shown.detail ? shown.missionId : null} error={events.error} replay={replaying} className="min-h-[200px] flex-1" />
          </div>
        </div>
        {/* below 1100 px the scene leads the single column, above the mission bar (not in Focus Mode, where
            FocusHeader stays first) */}
        <div className={cn("flex min-h-0 flex-col", !focus && "order-first min-[1100px]:order-none")}>
          <div className={cn("map-bg relative flex-1 overflow-hidden border border-border", focus ? "min-h-0" : "min-h-[460px] min-[1100px]:min-h-0")} data-atmo={atmo.phase}>
            {scene}
            {variant !== "global" && overlay && <p className="pointer-events-none absolute left-3 top-3 max-md:max-w-[calc(100%-9rem)] label text-faint">{overlay}</p>}
            {variant !== "global" && replay.loading && <p className="pointer-events-none absolute left-3 top-3 max-md:max-w-[calc(100%-9rem)] label text-faint">loading the recorded events…</p>}
            {!focus && (
              <button type="button" ref={enterButtonRef} className="btn absolute right-3 top-3" onClick={() => setFocus(true)} aria-label="Enter focus mode">
                Focus mode
              </button>
            )}
          </div>
          {sceneTools && <div className="mt-2 flex shrink-0 flex-wrap items-center gap-2">{sceneTools}</div>}
        </div>
        <div className={cn("order-3 flex min-h-0 flex-col gap-2 min-[1100px]:order-none", focus && "hidden")}>
          <ThreatRail
            findings={shown.findings}
            loaded={shown.findingsLoaded}
            error={replaying ? null : findings.error}
            overflow={shown.threatOverflow}
            selectedId={selectedThreat}
            onOpen={(id, el) => select({ kind: "threat", id }, el)}
            missionId={shown.missionId}
            compact={wide && compactRail}
            foldedBand={railFold.band}
            foldedWide={railFold.wide}
            onFold={(folded) => setRailOpen(!folded)}
            className="min-h-0 flex-1"
          />
        </div>
        <div className={cn("order-4", !focus && "min-[1100px]:order-none min-[1100px]:col-span-3", focus && !showPath && "hidden", variant === "global" && "hidden")}>
          <LifecyclePath lifecycle={shown.detail?.lifecycle ?? null} reducedMotion={reducedMotion} live={animated} action={currentAction(shown)} />
        </div>
      </div>
      <MapPanels selection={selection} data={panelData} onClose={close} onSelect={select} />
      {/* replayed effects are announced only while paused (at 4× a polite region would queue them), marked as a replay */}
      <LiveAnnouncer effects={replaying ? (replay.state.playing ? [] : replay.effects) : liveEffects} prefix={replaying ? "Replay: " : ""} message={replayMessage} />
    </>
  );
}
