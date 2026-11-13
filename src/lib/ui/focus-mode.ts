// Focus Mode (the full-screen graph view) has no API state of its own — it is local UI state in
// MissionLayout. The one piece of logic worth a pure, tested function is the Escape decision: it must
// defer to the side panel's own Escape handling (use-panel-selection.ts closes an open panel on the
// first Escape) and never act on an Escape some other handler already consumed.

/**
 * Whether a window-level Escape keypress exits Focus Mode. `selectionOpen` is true while a side panel is
 * open: that Escape only closes the panel (use-panel-selection.ts), so Focus Mode stays and this returns
 * false; a second Escape, with the panel now closed, exits it. `defaultPrevented` is true when another
 * handler (a side panel, the replay bar) already acted on this same Escape; such a keypress is ignored
 * entirely, here and by Focus Mode.
 */
export function escapeExitsFocus(state: { focusActive: boolean; selectionOpen: boolean; defaultPrevented: boolean }): boolean {
  if (!state.focusActive || state.defaultPrevented || state.selectionOpen) return false;
  return true;
}

/**
 * Whether the focus header's stale/error indicator should render at all: nothing when the data is fresh
 * and error-free, the same quiet-by-default rule the rest of the map follows (the Mission Bar only adds
 * "· stale" / the error text to its trailing status line when one applies).
 */
export function showFocusIndicator(stale: boolean, error: string | null): boolean {
  return stale || error !== null;
}

/**
 * The sr-only live region's text for the focus header's stale/error indicator. Deliberately excludes the
 * poll timestamp (`generatedAt` is a new value on every poll, so including it would re-announce "<error>
 * <time>" every poll while an error or staleness persists); an always-mounted region with this text (the
 * caller never removes the region itself, only its content changes) also avoids the "inserted already
 * holding content" case some screen readers miss. Fresh, error-free data announces nothing.
 */
export function focusIndicatorAnnouncement(stale: boolean, error: string | null): string {
  const parts: string[] = [];
  if (stale) parts.push("Data stale.");
  if (error) parts.push(error);
  return parts.join(" ");
}

/** The label a replay's Pause/Resume/Play/Restart button shows while paused (the live `replaying`
 * button is always "Pause"). `play` rewinds to step 0 when the replay is at its last step (replay.ts),
 * so a paused button at the last step must read "Restart", not "Resume" (which would mislead: nothing
 * resumes, it restarts). At index 0 (including a single-step replay, where index 0 is also the last
 * step) it reads "Play", since nothing has played yet.
 */
export function replayPlayLabel(state: { playing: boolean; index: number; length: number }): "Pause" | "Play" | "Resume" | "Restart" {
  if (state.playing) return "Pause";
  if (state.index <= 0) return "Play";
  if (state.index >= state.length - 1) return "Restart";
  return "Resume";
}

/**
 * The scene's wheel-zoom mode: "plain" (a bare wheel zooms, and below 1024px the map owns touch gestures
 * outright, including pinch) applies at the wide desktop layout (≥ 1100px, `wide`) and in Focus Mode on a
 * touch-sized viewport (`focus && !desktop`, i.e. Focus Mode below the 1024px `desktop` breakpoint, where
 * the map fills the screen and there is no page to scroll past it). Everywhere else only Ctrl/⌘ + wheel
 * zooms, so a long page still scrolls normally.
 */
export function mapWheelMode({ wide, focus, desktop }: { wide: boolean; focus: boolean; desktop: boolean }): "plain" | "modifier" {
  return wide || (focus && !desktop) ? "plain" : "modifier";
}

/**
 * Whether the map owns touch gestures outright (two-finger pinch/pan, one-finger pan on the background):
 * only in Focus Mode below the 1024px `desktop` breakpoint, where the scene fills the screen and there is
 * no page to scroll or pinch instead. Unlike `mapWheelMode`, `wide` plays no part here: the wide desktop
 * layout (≥ 1100px) still uses a bare wheel to zoom, but it must never arm touch-only bookkeeping — a
 * trackpad's page-pinch gesture and a mouse released outside the SVG have to behave exactly as on a
 * desktop that never ran this code (R12).
 */
export function touchGestures({ focus, desktop }: { focus: boolean; desktop: boolean }): boolean {
  return focus && !desktop;
}
