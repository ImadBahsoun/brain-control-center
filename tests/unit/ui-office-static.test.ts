// Static invariants of the office view: no filters or raw HTML in its components, no approve control, card
// text at a readable world size, its motion on `.fx` (one-shot walk) and `.loop` (glow, core) selectors only,
// and its page is a client shell.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(process.cwd(), "src");
const OFFICE = path.join(SRC, "components", "office");
const read = (f: string) => fs.readFileSync(f, "utf8");
const officeFiles = fs
  .readdirSync(OFFICE)
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => path.join(OFFICE, f));

const css = read(path.join(SRC, "app", "globals.css")).replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.replace(/@keyframes\s+[\w-]+\s*\{[\s\S]*?\n\}/g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: (m[1] ?? "").trim(), body: m[2] ?? "" }));

describe("office static invariants", () => {
  it("covers the office components", () => {
    expect(officeFiles.length).toBeGreaterThanOrEqual(10);
  });
  it("uses no SVG filter, backdrop filter or raw HTML", () => {
    for (const f of officeFiles) expect(/<filter|filter=|backdropFilter|feGaussianBlur|dangerouslySetInnerHTML/.test(read(f)), f).toBe(false);
  });
  it("has no approve control: no button carries approve or grant text", () => {
    for (const f of officeFiles) {
      const buttons = read(f).match(/<button[\s\S]*?<\/button>/g) ?? [];
      for (const b of buttons) expect(/approve|grant/i.test(b), `${f}: ${b.slice(0, 80)}`).toBe(false);
    }
  });
  it("draws its card and tag text at ≥ 14.7 world px (≥ 11 px at the 0.75 world → screen scale)", () => {
    const text = rules.filter((r) => /^\.office-(title|row|num|alert|tag)$/.test(r.selector));
    expect(text.map((r) => r.selector).sort()).toEqual([".office-alert", ".office-num", ".office-row", ".office-tag", ".office-title"]);
    for (const r of text) {
      const m = /font-size\s*:\s*([\d.]+)px/.exec(r.body);
      expect(m, r.selector).not.toBeNull();
      expect(Number(m?.[1]), r.selector).toBeGreaterThanOrEqual(14.7);
    }
  });
  it("walks tokens as a one-shot .fx animation and pulses the monitor glow as a .loop", () => {
    const walker = rules.find((r) => /animation\s*:\s*walk\b/.test(r.body));
    expect(walker?.selector).toBe(".fx.walker");
    const glow = rules.find((r) => r.selector.includes("office-glow") && /animation\s*:/.test(r.body));
    expect(glow?.selector).toBe(".loop.office-glow");
    // the walker rests at its destination when the animation is removed (reduced motion)
    const base = rules.find((r) => r.selector === ".walker");
    expect(base?.body).toMatch(/offset-distance\s*:\s*100%/);
    expect(read(path.join(OFFICE, "office-walker.tsx"))).toMatch(/className="fx walker"/);
    expect(read(path.join(OFFICE, "office-core.tsx"))).toMatch(/"spin", moving && "loop"/);
  });
  it("serves /office as a client shell", () => {
    expect(read(path.join(SRC, "app", "office", "page.tsx")).trimStart().startsWith('"use client"')).toBe(true);
  });
});
