import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { browserStorage, LEFT_FOLD_KEY, parseFold, RAIL_FOLD_KEY, railFolded, railWidths, readFold, writeFold } from "@/lib/ui/fold-state";

const SRC = path.resolve(__dirname, "..", "..", "src");
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), "utf8");

describe("parseFold", () => {
  it("maps the two stored values", () => {
    expect(parseFold("open")).toBe(true);
    expect(parseFold("folded")).toBe(false);
  });
  it.each([null, undefined, "", "OPEN", "true", "1", " open", 1, {}])("treats %j as never chosen", (raw) => {
    expect(parseFold(raw)).toBeNull();
  });
});

describe("readFold / writeFold", () => {
  const memoryStorage = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  it("round-trips a choice per key", () => {
    const s = memoryStorage();
    expect(writeFold(s, RAIL_FOLD_KEY, false)).toBe(true);
    expect(writeFold(s, LEFT_FOLD_KEY, true)).toBe(true);
    expect(readFold(s, RAIL_FOLD_KEY)).toBe(false);
    expect(readFold(s, LEFT_FOLD_KEY)).toBe(true);
  });
  it("reads an empty or garbage store as never chosen", () => {
    const s = memoryStorage();
    expect(readFold(s, RAIL_FOLD_KEY)).toBeNull();
    s.setItem(RAIL_FOLD_KEY, "{\"open\":true}");
    expect(readFold(s, RAIL_FOLD_KEY)).toBeNull();
  });
  it("survives storage that throws on read or write, and a missing storage", () => {
    const boom = () => {
      throw new Error("SecurityError");
    };
    expect(readFold({ getItem: boom }, RAIL_FOLD_KEY)).toBeNull();
    expect(writeFold({ setItem: boom }, RAIL_FOLD_KEY, true)).toBe(false);
    expect(readFold(null, RAIL_FOLD_KEY)).toBeNull();
    expect(writeFold(null, RAIL_FOLD_KEY, true)).toBe(false);
  });
});

describe("browserStorage", () => {
  it("is null without a window (the server render)", () => {
    expect(browserStorage()).toBeNull();
  });
  it("is null when touching localStorage throws", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    });
    try {
      expect(browserStorage()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("railFolded", () => {
  it("keeps each band's default when never chosen: open ≥ 1440, folded 1100–1439", () => {
    expect(railFolded(null)).toEqual({ wide: false, band: true });
  });
  it("applies an explicit choice to both bands", () => {
    expect(railFolded(false)).toEqual({ wide: true, band: true });
    expect(railFolded(true)).toEqual({ wide: false, band: false });
  });
});

describe("railWidths", () => {
  it("is 272 px open and 44 px folded, per band", () => {
    expect(railWidths({ compact: false, choice: null })).toEqual({ wide: "272px", band: "44px" });
    expect(railWidths({ compact: false, choice: true })).toEqual({ wide: "272px", band: "272px" });
    expect(railWidths({ compact: false, choice: false })).toEqual({ wide: "44px", band: "44px" });
  });
  it("the compact (no findings) rail is 44 px whatever was chosen", () => {
    for (const choice of [null, true, false]) expect(railWidths({ compact: true, choice })).toEqual({ wide: "44px", band: "44px" });
  });
});

describe("desktop fold wiring", () => {
  const layout = read("components", "shell", "mission-layout.tsx");
  const rail = read("components", "map", "threat-rail.tsx");
  it("the left column folds to 44 px at both widths, only outside Focus Mode", () => {
    expect(layout).toMatch(/!focus && \(leftFolded \? "min-\[1100px\]:\[--left-w:44px\]" : "min-\[1100px\]:\[--left-w:200px\] min-\[1440px\]:\[--left-w:236px\]"\)/);
  });
  it("fold controls and folded strips exist only from 1100 px up", () => {
    expect(layout).toMatch(/className="btn hidden [^"]*min-\[1100px\]:inline-flex".*aria-expanded aria-label="Hide the resources/);
    expect(layout).toMatch(/hud hidden [^"]*min-\[1100px\]:flex/);
    expect(rail).toMatch(/className="btn hidden py-0\.5 min-\[1100px\]:inline-flex".*aria-expanded aria-label="Hide the findings list"/);
    expect(rail).toContain('"min-[1100px]:max-[1440px]:flex"');
    expect(rail).toContain('"min-[1440px]:flex"');
    expect(rail).toContain('"min-[1100px]:max-[1440px]:hidden"');
    expect(rail).toContain('"min-[1440px]:hidden"');
  });
  it("the folded strips' buttons say what they open and are not expanded", () => {
    expect(layout).toMatch(/aria-expanded=\{false\}\s+aria-label="Show the resources/);
    expect(rail).toMatch(/aria-expanded=\{false\}\s+aria-label=\{`Show the findings list/);
  });
});
