import { describe, expect, it } from "vitest";
import { escapeExitsFocus, focusIndicatorAnnouncement, mapWheelMode, replayPlayLabel, showFocusIndicator, touchGestures } from "@/lib/ui/focus-mode";

describe("escapeExitsFocus", () => {
  it("exits Focus Mode on a plain Escape, with no panel open and nothing else handling it", () => {
    expect(escapeExitsFocus({ focusActive: true, selectionOpen: false, defaultPrevented: false })).toBe(true);
  });

  it("does nothing when Focus Mode is not active", () => {
    expect(escapeExitsFocus({ focusActive: false, selectionOpen: false, defaultPrevented: false })).toBe(false);
  });

  it("leaves Focus Mode alone while a side panel is open: that Escape only closes the panel", () => {
    expect(escapeExitsFocus({ focusActive: true, selectionOpen: true, defaultPrevented: false })).toBe(false);
  });

  it("exits on the SECOND Escape, once the panel has closed (selectionOpen now false)", () => {
    expect(escapeExitsFocus({ focusActive: true, selectionOpen: false, defaultPrevented: false })).toBe(true);
  });

  it("ignores an Escape another handler already acted on", () => {
    expect(escapeExitsFocus({ focusActive: true, selectionOpen: false, defaultPrevented: true })).toBe(false);
  });

  it("a prevented Escape is ignored even with a panel open", () => {
    expect(escapeExitsFocus({ focusActive: true, selectionOpen: true, defaultPrevented: true })).toBe(false);
  });
});

describe("showFocusIndicator", () => {
  it("shows nothing when the data is fresh and error-free", () => {
    expect(showFocusIndicator(false, null)).toBe(false);
  });

  it("shows on stale data alone", () => {
    expect(showFocusIndicator(true, null)).toBe(true);
  });

  it("shows on an error alone, even when not stale", () => {
    expect(showFocusIndicator(false, "tasks: fetch failed")).toBe(true);
  });

  it("shows when both stale and in error", () => {
    expect(showFocusIndicator(true, "tasks: fetch failed")).toBe(true);
  });

  it("an empty-string error still counts (only null means no error)", () => {
    expect(showFocusIndicator(false, "")).toBe(true);
  });
});

describe("focusIndicatorAnnouncement", () => {
  it("announces nothing when fresh and error-free", () => {
    expect(focusIndicatorAnnouncement(false, null)).toBe("");
  });

  it("announces staleness alone", () => {
    expect(focusIndicatorAnnouncement(true, null)).toBe("Data stale.");
  });

  it("announces the error text alone, with no timestamp mixed in", () => {
    expect(focusIndicatorAnnouncement(false, "tasks: fetch failed")).toBe("tasks: fetch failed");
  });

  it("announces both stale and the error together", () => {
    expect(focusIndicatorAnnouncement(true, "tasks: fetch failed")).toBe("Data stale. tasks: fetch failed");
  });
});

describe("replayPlayLabel", () => {
  it("reads Pause while playing, regardless of position", () => {
    expect(replayPlayLabel({ playing: true, index: 0, length: 5 })).toBe("Pause");
    expect(replayPlayLabel({ playing: true, index: 4, length: 5 })).toBe("Pause");
  });

  it("reads Play at the very start (nothing has played yet)", () => {
    expect(replayPlayLabel({ playing: false, index: 0, length: 5 })).toBe("Play");
  });

  it("reads Resume somewhere in the middle", () => {
    expect(replayPlayLabel({ playing: false, index: 2, length: 5 })).toBe("Resume");
  });

  it("reads Restart at the last step (play would rewind to step 0, not resume)", () => {
    expect(replayPlayLabel({ playing: false, index: 4, length: 5 })).toBe("Restart");
  });

  it("a single-step replay (index 0 is also the last step) reads Play, not Restart", () => {
    expect(replayPlayLabel({ playing: false, index: 0, length: 1 })).toBe("Play");
  });
});

describe("mapWheelMode", () => {
  // all 8 combinations of wide / focus / desktop
  it("wide: plain regardless of focus or desktop", () => {
    expect(mapWheelMode({ wide: true, focus: false, desktop: false })).toBe("plain");
    expect(mapWheelMode({ wide: true, focus: false, desktop: true })).toBe("plain");
    expect(mapWheelMode({ wide: true, focus: true, desktop: false })).toBe("plain");
    expect(mapWheelMode({ wide: true, focus: true, desktop: true })).toBe("plain");
  });
  it("not wide, not in Focus Mode: modifier regardless of desktop", () => {
    expect(mapWheelMode({ wide: false, focus: false, desktop: false })).toBe("modifier");
    expect(mapWheelMode({ wide: false, focus: false, desktop: true })).toBe("modifier");
  });
  it("not wide, in Focus Mode on a touch-sized viewport (below the 1024px desktop breakpoint): plain", () => {
    expect(mapWheelMode({ wide: false, focus: true, desktop: false })).toBe("plain");
  });
  it("not wide, in Focus Mode at desktop width: modifier (a desktop Focus Mode still only zooms on Ctrl/⌘ + wheel)", () => {
    expect(mapWheelMode({ wide: false, focus: true, desktop: true })).toBe("modifier");
  });
});

describe("touchGestures (R12: desktop never arms touch-only paths, regardless of wheelZoom)", () => {
  it("is true only in Focus Mode below the 1024px desktop breakpoint", () => {
    expect(touchGestures({ focus: true, desktop: false })).toBe(true);
  });
  it("is false at desktop width even while in Focus Mode", () => {
    expect(touchGestures({ focus: true, desktop: true })).toBe(false);
  });
  it("is false outside Focus Mode, on a touch-sized viewport", () => {
    expect(touchGestures({ focus: false, desktop: false })).toBe(false);
  });
  it("is false outside Focus Mode, at desktop width", () => {
    expect(touchGestures({ focus: false, desktop: true })).toBe(false);
  });
});
