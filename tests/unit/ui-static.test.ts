// Static invariants of the UI code: the client never fetches outside use-poll, never imports server
// modules, never names a method or an absolute URL, every page is a client shell, and the CSS animates
// only transform, opacity and offset-distance with a reduced-motion override.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const uiFiles = [
  ...walk(path.join(SRC, "app")).filter((f) => !f.includes(`${path.sep}api${path.sep}`)),
  ...walk(path.join(SRC, "components")),
  ...walk(path.join(SRC, "hooks")),
  ...walk(path.join(SRC, "lib", "ui")),
].filter((f) => /\.(tsx?|css)$/.test(f));

const read = (f: string) => fs.readFileSync(f, "utf8");
const rel = (f: string) => path.relative(SRC, f);

describe("UI static invariants", () => {
  it("covers the UI tree", () => {
    expect(uiFiles.length).toBeGreaterThan(30);
  });
  it("calls fetch only inside src/hooks/use-poll.ts", () => {
    for (const f of uiFiles) {
      if (f.endsWith(path.join("hooks", "use-poll.ts"))) continue;
      expect(/\bfetch\(/.test(read(f)), rel(f)).toBe(false);
    }
  });
  it("contains no absolute http(s) URL", () => {
    for (const f of uiFiles) expect(/https?:\/\//.test(read(f)), rel(f)).toBe(false);
  });
  it("imports nothing from @/server", () => {
    for (const f of uiFiles) expect(/from\s+["']@\/server/.test(read(f)), rel(f)).toBe(false);
  });
  it("never names an HTTP method option (no `method:`)", () => {
    for (const f of uiFiles) expect(/\bmethod\s*:/.test(read(f)), rel(f)).toBe(false);
  });
  it("every page under src/app is a client shell", () => {
    const pages = walk(path.join(SRC, "app")).filter((f) => f.endsWith("page.tsx"));
    expect(pages.length).toBeGreaterThanOrEqual(5);
    for (const f of pages) expect(read(f).trimStart().startsWith('"use client"'), rel(f)).toBe(true);
  });
  it("has no approve control: no button carries approve/grant text in the gate or panel components", () => {
    const files = [...walk(path.join(SRC, "components", "panels")), ...walk(path.join(SRC, "components", "map"))];
    for (const f of files) {
      const text = read(f);
      const buttons = text.match(/<button[\s\S]*?<\/button>/g) ?? [];
      for (const b of buttons) expect(/approve|grant/i.test(b), `${rel(f)}: ${b.slice(0, 80)}`).toBe(false);
    }
  });
  it("the Approval Center has no control: no button, form, click handler or method under components/approvals and app/approvals", () => {
    const files = [...walk(path.join(SRC, "components", "approvals")), ...walk(path.join(SRC, "app", "approvals"))];
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      const text = read(f);
      for (const banned of [/<button/i, /<form/i, /onClick/, /\bmethod\s*:/]) expect(banned.test(text), `${rel(f)}: ${banned}`).toBe(false);
    }
  });
  it("never touches the clipboard anywhere in src", () => {
    for (const f of walk(SRC).filter((x) => /\.(tsx?)$/.test(x))) expect(/navigator\.clipboard/.test(read(f)), rel(f)).toBe(false);
  });
  it("uses no Tailwind truncate class (the read-only grep forbids the word)", () => {
    for (const f of uiFiles) expect(/\btruncate\b/.test(read(f)), rel(f)).toBe(false);
  });

  it("the root layout sets viewport-fit cover (Safari safe-area support)", () => {
    const layout = read(path.join(SRC, "app", "layout.tsx"));
    expect(layout).toMatch(/viewportFit\s*:\s*["']cover["']/);
  });

  it("the mission-layout Focus Mode branch reaches under the device's safe-area insets", () => {
    const missionLayout = read(path.join(SRC, "components", "shell", "mission-layout.tsx"));
    expect(missionLayout).toMatch(/env\(safe-area-inset-bottom\)/);
  });

  it("R4: the mission strip's 'N live · M open' label never wraps mid-line", () => {
    const missionBar = read(path.join(SRC, "components", "map", "mission-bar.tsx"));
    const span = missionBar.match(/<span className="[^"]*"\s+title="live = recent Brain activity[^"]*">/);
    expect(span).not.toBeNull();
    expect(span?.[0]).toMatch(/\bshrink-0\b/);
    expect(span?.[0]).toMatch(/\bwhitespace-nowrap\b/);
  });

  describe("globals.css motion rules", () => {
    // comments may name what the rules forbid; only the declarations count
    const css = read(path.join(SRC, "app", "globals.css")).replace(/\/\*[\s\S]*?\*\//g, "");
    it("animates only transform, opacity and offset-distance inside @keyframes", () => {
      const blocks = css.match(/@keyframes\s+[\w-]+\s*\{[\s\S]*?\n\}/g) ?? [];
      expect(blocks.length).toBeGreaterThan(3);
      for (const block of blocks) {
        const props = [...block.matchAll(/^\s*([a-z-]+)\s*:/gm)].map((m) => m[1]);
        expect(props.length, block.slice(0, 40)).toBeGreaterThan(0);
        for (const p of props) expect(["transform", "opacity", "offset-distance"], `${block.slice(0, 40)} → ${p}`).toContain(p);
      }
    });
    it("stops every loop and effect under prefers-reduced-motion", () => {
      const m = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\}\s*\}/);
      expect(m).not.toBeNull();
      expect(m?.[1]).toMatch(/\.fx/);
      expect(m?.[1]).toMatch(/\.loop/);
      expect(m?.[1]).toMatch(/animation:\s*none\s*!important/);
    });
    it("uses no SVG filter or backdrop-filter over the map", () => {
      expect(/backdrop-filter|filter\s*:\s*(blur|drop-shadow|url)/.test(css)).toBe(false);
      for (const f of uiFiles.filter((x) => x.includes(`${path.sep}map${path.sep}`))) {
        expect(/<filter|feGaussianBlur|backdropFilter|filter=/.test(read(f)), rel(f)).toBe(false);
      }
    });

    // the innermost `selector { declarations }` rules, with the @keyframes blocks taken out
    const rules = [...css.replace(/@keyframes\s+[\w-]+\s*\{[\s\S]*?\n\}/g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: (m[1] ?? "").trim(), body: m[2] ?? "" }));
    const fontSize = (body: string): number | null => {
      const m = /font-size\s*:\s*([\d.]+)px/.exec(body);
      return m ? Number(m[1]) : null;
    };
    it("runs animations only on .loop (continuous, stopped under reduced motion) and .fx (one-shot) elements", () => {
      const animated = rules.filter((r) => /\banimation(-[a-z]+)?\s*:/.test(r.body));
      expect(animated.length).toBeGreaterThan(5);
      for (const r of animated) for (const sel of r.selector.split(",")) expect(/\.loop\b|\.fx\b/.test(sel), sel.trim()).toBe(true);
    });
    it("draws no text below 11 px, and map SVG text at ≥ 14.7 world px (≥ 11 px at the 0.75 world → screen scale)", () => {
      const sized = rules.filter((r) => fontSize(r.body) !== null);
      expect(sized.length).toBeGreaterThan(10);
      for (const r of sized) expect(fontSize(r.body), r.selector).toBeGreaterThanOrEqual(11);
      const svgText = sized.filter((r) => /^\.(node|core|threat)-[\w-]+$/.test(r.selector));
      expect(svgText.map((r) => r.selector)).toEqual(expect.arrayContaining([".node-title", ".node-sub", ".node-status", ".node-activity", ".node-meta", ".node-no", ".core-sub", ".core-state", ".threat-id", ".threat-sev"]));
      for (const r of svgText) expect(fontSize(r.body), r.selector).toBeGreaterThanOrEqual(14.7);
      for (const sel of [".label", ".chip", ".hud-title", ".field-grid dt"]) {
        const r = sized.find((x) => x.selector === sel);
        expect(r, sel).toBeDefined();
        expect(fontSize(r?.body ?? ""), sel).toBeGreaterThanOrEqual(11);
      }
    });
  });

  it("sets no inline font size below 11 and no Tailwind text-[<11px] class in the UI components", () => {
    for (const f of uiFiles.filter((x) => x.endsWith(".tsx"))) {
      const text = read(f);
      for (const m of text.matchAll(/fontSize\s*[:=]\s*\{?\s*["']?([\d.]+)/g)) expect(Number(m[1]), `${rel(f)}: ${m[0]}`).toBeGreaterThanOrEqual(11);
      for (const m of text.matchAll(/text-\[([\d.]+)px\]/g)) expect(Number(m[1]), `${rel(f)}: ${m[0]}`).toBeGreaterThanOrEqual(11);
    }
  });

  describe("Focus Mode keeps the scene at a stable tree position", () => {
    // Focus Mode must not remount `scene` (it holds the Command Map's pan/zoom state): mission-layout.tsx
    // may only toggle classes/attributes around it, never key it or swap its wrapping element by mode.
    const file = read(path.join(SRC, "components", "shell", "mission-layout.tsx"));
    it("renders {scene} exactly once, as a plain expression (no key)", () => {
      const occurrences = file.match(/\{scene\}/g) ?? [];
      expect(occurrences.length).toBe(1);
      expect(file).not.toMatch(/key=\{?["'`]?scene\b/);
    });
    it("does not swap {scene}'s wrapping element between two branches by focus mode (only its classes/attrs may differ)", () => {
      const idx = file.indexOf("{scene}");
      expect(idx).toBeGreaterThan(-1);
      const before = file.slice(Math.max(0, idx - 200), idx);
      // a className/attribute ternary (`focus ? "a" : "b"`) is fine; a ternary choosing between two
      // JSX elements (`focus ? (<div>…` / `focus ? <div>…`) right before {scene} would not be.
      expect(before).not.toMatch(/focus\s*\?\s*\(?\s*</);
    });
  });

  describe("Focus Mode fix regressions (Q1, R1, R8)", () => {
    const missionLayout = read(path.join(SRC, "components", "shell", "mission-layout.tsx"));
    const focusHeader = read(path.join(SRC, "components", "map", "focus-header.tsx"));

    it("Q1: the LifecyclePath wrapper's min-[1100px]: classes only apply outside Focus Mode", () => {
      // the regression: these classes applied unconditionally, tying the path's grid `order` with the map's
      // and spanning 3 columns in Focus Mode's single-column grid, squeezing the map into an implicit column
      const lifecyclePathDiv = missionLayout.match(/<div className=\{cn\([^)]*order-4[^)]*\)\}>\s*<LifecyclePath/);
      expect(lifecyclePathDiv).not.toBeNull();
      const snippet = lifecyclePathDiv?.[0] ?? "";
      expect(snippet).toMatch(/!focus\s*&&\s*["'`]min-\[1100px]:order-none min-\[1100px]:col-span-3["'`]/);
    });

    it("R1: FocusHeader is rendered before the Mission Bar, so DOM/tab order matches the visual order", () => {
      const focusHeaderIdx = missionLayout.indexOf("<FocusHeader");
      const missionBarIdx = missionLayout.indexOf("<MissionBar");
      expect(focusHeaderIdx).toBeGreaterThan(-1);
      expect(missionBarIdx).toBeGreaterThan(-1);
      expect(focusHeaderIdx).toBeLessThan(missionBarIdx);
    });

    it("R8: the replay controls (REPLAY chip, Pause/Resume, Exit replay) render only while replaying", () => {
      // "chip-synth" and "Exit replay" each appear exactly once, both after the `{replaying && (` guard
      // and before the next sibling block ("Show Mission Path"), so they sit inside that one guarded block.
      const guardIdx = focusHeader.indexOf("{replaying &&");
      expect(guardIdx).toBeGreaterThan(-1);
      const showPathIdx = focusHeader.indexOf("Show Mission Path");
      expect(showPathIdx).toBeGreaterThan(guardIdx);

      expect(focusHeader.match(/chip-synth/g)?.length).toBe(1);
      expect(focusHeader.match(/Exit replay/g)?.length).toBe(1);
      const chipIdx = focusHeader.indexOf("chip-synth");
      const exitReplayIdx = focusHeader.indexOf("Exit replay");
      expect(chipIdx).toBeGreaterThan(guardIdx);
      expect(chipIdx).toBeLessThan(showPathIdx);
      expect(exitReplayIdx).toBeGreaterThan(guardIdx);
      expect(exitReplayIdx).toBeLessThan(showPathIdx);
    });
  });
});
