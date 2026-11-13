// Static invariants of the Global Office: figures come from agent runs and recorded waits, never from a task's
// lifecycle state; every mission link is encoded; the page adds no polls; Mission mode keeps the same OfficeScene
// props; the toggle is two pressed-state buttons of at least 44 px; MissionLayout's global variant only hides things.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(process.cwd(), "src");
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), "utf8");
const scene = read("components", "office", "global-office-scene.tsx");
const roster = read("components", "office", "global-roster.tsx");
const capacity = read("components", "office", "global-capacity.tsx");
const toggle = read("components", "office", "office-mode-toggle.tsx");
const model = read("lib", "ui", "global-office.ts");
const page = read("app", "office", "page.tsx");
const layout = read("components", "shell", "mission-layout.tsx");

describe("Global Office static invariants", () => {
  it("never reads a task's lifecycle or status in the scene: presence is the model's, from runs and waits only", () => {
    expect(scene).not.toMatch(/lifecycle/i);
    expect(scene).not.toMatch(/\.status\b/);
    expect(scene).not.toMatch(/tasks\??\.tasks/);
    // the model creates instances in exactly two loops: /api/agents active and /api/agents queued
    expect(model.match(/instances\.push\(/g)).toHaveLength(2);
    expect(model).toMatch(/for \(const r of agents\?\.active \?\? \[\]\) \{\s+if \(r\.status !== "pending"\) continue;/);
    expect(model).toMatch(/for \(const q of agents\?\.queued \?\? \[\]\)/);
    expect(model.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")).not.toMatch(/lifecycle/i);
  });
  it("draws the activity lines from the model's running and queued instances only, never a mission's lifecycle or the map's edges", () => {
    // the scene draws a line and a plate only for model.activityLines
    expect(scene.match(/model\.activityLines\.map\(/g)).toHaveLength(4); // the plates' input, the text version, the lines, their plates
    expect(scene).toMatch(/model\.activityLines\.map\(\(l\) => \(\s*<GlobalActivityLine key=\{l\.role\} line=\{l\} loop=\{loop\} \/>/);
    // never the focused mission's lifecycle edges (the Mission Office's model.edges / scene.connections)
    expect(scene).not.toMatch(/\.edges\b|\bconnections\b|buildOfficeScene|CommandMapModel|EdgeModel/);
    // the model: one line per room from its running and queued counts and instance states, nothing else
    const code = model.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(code).toMatch(/activityLines: rooms\.flatMap\(\(r\) => activityLine\(r\) \?\? \[\]\)/);
    const fn = /export function activityLine\(room: GlobalRoom\)[\s\S]*?\n\}\n/.exec(code)?.[0] ?? "";
    // queued launches count only within the stale threshold (R7: one denied that long ago is likely abandoned)
    expect(fn).toMatch(/const queued = room\.instances\.filter\(\(i\) => i\.state === "queued" && !i\.overStaleThreshold\);\s*if \(room\.running \+ queued\.length === 0\) return null;/);
    expect(fn).not.toMatch(/missionStatus|lifecycle|\.status\b|tasks|state === "stale"/);
    expect(fn.match(/i\.state === "(running|queued)"/g)).toEqual(['i.state === "queued"', 'i.state === "running"']);
  });
  it("keeps the activity lines decorative and still under reduced motion", () => {
    const fn = /function GlobalActivityLine\([\s\S]*?\n\}\n/.exec(scene)?.[0] ?? "";
    expect(fn).not.toBe("");
    // no focus stop, no role: the text version names each line
    expect(fn).not.toMatch(/tabIndex|role=|onClick|onKeyDown/);
    expect(scene).toMatch(/<g className="edges" aria-hidden="true">\s*\{model\.activityLines\.map/);
    // the flow particles (the only .loop) only while motion is allowed; the static dashes otherwise
    expect(fn.match(/\bloop"/g)).toHaveLength(2);
    expect(fn).toMatch(/\{running &&\s*loop &&\s*Array\.from/);
    expect(fn).toMatch(/\{running && !loop && <path className="edge-static-flow"/);
    // the Mission Office's edge strokes: the active style while running, the dimmer dashed pending style while queued
    expect(fn).toMatch(/cn\("edge", running \? "st-running" : "st-pending"\)/);
    // drawn on the floor, before (behind) the rooms and the core
    expect(scene.indexOf('<g className="edges" aria-hidden="true">')).toBeLessThan(scene.indexOf('<g className="rooms">'));
    expect(scene.indexOf("<OfficeBackdrop />")).toBeLessThan(scene.indexOf('<g className="edges" aria-hidden="true">'));
  });
  it("builds every mission link with encodeURIComponent, in one helper", () => {
    for (const [name, text] of [
      ["scene", scene],
      ["roster", roster],
      ["capacity", capacity],
      ["toggle", toggle],
    ] as const)
      expect(text, name).not.toContain("/tasks/");
    const links = model.match(/\/tasks\/[^\n]*/g) ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]).toContain("/tasks/${encodeURIComponent(taskId)}");
    expect(roster).toMatch(/href=\{missionHref\(/);
    expect(scene).toMatch(/router\.push\(missionHref\(/);
  });
  it("adds no polls: the page and the Global Office components never call usePoll or fetch", () => {
    for (const text of [page, scene, roster, capacity, toggle, model]) {
      expect(text).not.toMatch(/usePoll\(/);
      expect(text).not.toMatch(/\bfetch\(/);
    }
    expect(page).toMatch(/agents=\{v\.agents\.data\} tasks=\{v\.tasks\.data\} governor=\{v\.governor\.data\}/);
  });
  it("never says disconnected", () => {
    for (const text of [scene, roster, capacity, toggle, model]) expect(text).not.toMatch(/disconnect/i);
  });
  it("renders Mission mode's OfficeScene with the same props as before", () => {
    const m = /<OfficeScene\s+([\s\S]*?)\/>/.exec(page);
    expect(m).not.toBeNull();
    const props = [...(m?.[1] ?? "").matchAll(/(\w+)=\{/g)].map((x) => x[1]);
    expect(props).toEqual(["model", "effects", "selection", "onSelect", "reducedMotion", "wheelZoom", "focused", "touchGestures", "agents", "stepMs"]);
    expect(m?.[1]).toContain("agents={v.replaying ? null : v.agents.data}");
    expect(m?.[1]).toContain("stepMs={v.replaying ? STEP_MS[v.replay.state.speed] : null}");
    expect(page).toMatch(/<MapAtmosphere atmo=\{v\.atmo\} reducedMotion=\{v\.reducedMotion\} \/>/);
  });
  it("offers the mode as two pressed-state buttons at least 44 px high", () => {
    const buttons = toggle.match(/<button[\s\S]*?<\/button>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(b).toMatch(/aria-pressed=\{mode === "(global|mission)"\}/);
      expect(b).toMatch(/className="[^"]*\bmin-h-11\b/);
    }
  });
  it("MissionLayout: sceneTools is a sibling after {scene}, and the global variant only hides the overlay, replay and path", () => {
    expect(layout.indexOf("{sceneTools && ")).toBeGreaterThan(layout.indexOf("{scene}"));
    expect(layout.match(/\{sceneTools && /g)).toHaveLength(1);
    expect(layout).toMatch(/variant !== "global" && overlay &&/);
    expect(layout).toMatch(/variant !== "global" && replay\.loading &&/);
    expect(layout).toMatch(/replayAvailable=\{variant !== "global" && replay\.available/);
    expect(layout).toMatch(/order-4[^)]*variant === "global" && "hidden"\)\}>\s*<LifecyclePath/);
  });
  it("ends any replay whenever the mode is global, a still-loading one too, without moving focus off the toggle", () => {
    // not only while `replaying`: a replay requested in Mission mode and still loading its events must not open later
    expect(page).toMatch(/useEffect\(\(\) => \{\s*if \(global\) exitReplay\(\);\s*\}, \[global, exitReplay\]\);/);
    expect(page).toContain("const exitReplay = v.replay.exit;");
    const code = page.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/global && replaying/);
    expect(code).not.toMatch(/leaveReplay/);
  });
  it("draws desks as decor only: no glow, no motion and no figure in a desk", () => {
    const desk = /function deskItems\([\s\S]*?\n\}\n/.exec(scene)?.[0] ?? "";
    expect(desk).not.toBe("");
    expect(desk).not.toMatch(/office-glow|\bloop\b|GlobalFigure|\bfx\b|inst\b/);
    // every room draws all six desks, whoever sits there
    expect(scene).toMatch(/const items = \[\.\.\.GLOBAL_DESKS\[room\.id\]\.flatMap\(deskItems\), \.\.\.figures\];/);
  });
  it("draws a figure only for a placed instance: seated ones from placed(room), the hit targets and tags from the same", () => {
    expect(scene.match(/<GlobalFigure /g)).toHaveLength(2);
    const room = /function GlobalRoleRoom\([\s\S]*?\n\}\n/.exec(scene)?.[0] ?? "";
    expect(room).toMatch(/const all = placed\(room\);/);
    expect(room.match(/all\s*\.filter\(\(x\) => x\.posture === "(seated|standing)"\)\s*\.map\(\(x\) =>/g)).toHaveLength(2);
    // a running figure glows; a stale one is amber and still
    expect(room).toMatch(/glow=\{x\.inst\.state === "running"\}/);
    expect(scene).toMatch(/const TONE: Record<GlobalInstance\["state"\], string> = \{ running: "var\(--signal\)", stale: "var\(--warn\)", queued: "var\(--text-dim\)" \};/);
    expect(scene).toMatch(/const drawn = model\.rooms\.flatMap\(\(r\) => placed\(r\)/);
    // queued figures always carry their tag; a seated figure's only while it is hovered or focused, one at a time
    expect(scene).toMatch(/\.filter\(\(d\) => d\.posture === "standing"\)\s*\.map\(\(d\) => \(\s*<Plate key=\{d\.inst\.key\} box=\{tagBox\(d\.p, d\.posture, queueTagSide\(d\.room\.id\)\)\}/);
    expect(scene).toMatch(/const taggedFigure = drawn\.find\(\(d\) => d\.posture === "seated" && d\.inst\.key === tagged\);/);
    expect(scene).toMatch(/<g className="tags" aria-hidden="true" pointerEvents="none">\s*\{taggedFigure && <Plate/);
  });
  it("keeps the floor paths decor: aria-hidden, still, no focus stop, under the activity lines", () => {
    const fn = /function GlobalFloorPaths\([\s\S]*?\n\}\n/.exec(scene)?.[0] ?? "";
    expect(fn).not.toBe("");
    expect(fn).toMatch(/aria-hidden="true"/);
    expect(fn).not.toMatch(/\bloop\b|particle|\bfx\b|tabIndex|role=|onClick|activityLines|model\./);
    expect(scene.indexOf("<OfficeBackdrop />")).toBeLessThan(scene.indexOf("<GlobalFloorPaths />"));
    expect(scene.indexOf("<GlobalFloorPaths />")).toBeLessThan(scene.indexOf('<g className="edges" aria-hidden="true">'));
    // dotted and never animated: not an edge stroke, no animation
    const css = fs.readFileSync(path.join(SRC, "app", "globals.css"), "utf8");
    const rule = /\.office-floor-path \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/stroke-dasharray/);
    expect(rule).not.toMatch(/animation/);
    expect(css).not.toMatch(/\.(loop|fx)\.office-floor-path/);
  });
  it("walks a token only from globalWalks of two consecutive /api/agents bodies, one-shot, never under reduced motion", () => {
    expect(scene.match(/<OfficeWalker /g)).toHaveLength(1);
    expect(scene).toMatch(/\{!reducedMotion &&\s*walks\.map\(\(w\) => \(\s*<OfficeWalker key=\{w\.key\} walker=\{w\} reducedMotion=\{false\} \/>/);
    expect(scene).toMatch(/const fresh = globalWalks\(prev, agents\);/);
    expect(scene.match(/setWalks\(/g)).toHaveLength(2); // add the fresh walks; remove each after its walk
    expect(scene).toMatch(/setWalks\(\(w\) => \[\.\.\.w, \.\.\.fresh\]/);
    const code = model.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    const fn = /export function globalWalks\([\s\S]*?\n\}\n/.exec(code)?.[0] ?? "";
    expect(fn).not.toBe("");
    expect(fn).not.toMatch(/lifecycle|missionStatus|tasks|\.queued/);
    // a stale run never walks in; a vanished run never walks back
    expect(fn).toMatch(/r\.staleOverThreshold/);
    expect(fn).toMatch(/next\.recent\.some\(\(x\) => x\.status !== "pending" && runKey\(x\) === runKey\(r\)\)/);
  });
  it("takes m only from the governor's three lane limits and n only from the room's running instances", () => {
    const code = model.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    const limit = /export function roomLimit\([\s\S]*?\n\}\n/.exec(code)?.[0] ?? "";
    expect([...new Set([...limit.matchAll(/limits\.(\w+)/g)].map((m) => m[1]))].sort()).toEqual(["max_developers", "max_total_agents", "max_validators"]);
    const card = /export function globalRoomCard\([\s\S]*?\n\}\n/.exec(code)?.[0] ?? "";
    expect(card).toMatch(/const n = room\.running;/);
    expect(card).toMatch(/const m = room\.limit;/);
    expect(card).not.toMatch(/room\.stale\b[^\n]*busy|instances\.length/);
    expect(scene).toMatch(/const limits = governor\?\.policy\?\.global \?\? agents\?\.limits \?\? null;/);
  });
  it("keeps the Global geometry module free of polls and of 'disconnected'", () => {
    const geometry = read("lib", "ui", "global-office-layout.ts");
    expect(geometry).not.toMatch(/usePoll\(|\bfetch\(/);
    expect(geometry).not.toMatch(/disconnect/i);
  });
  it("Focus Mode offers no path toggle in the global variant (its path is always hidden); Mission mode keeps it", () => {
    const header = read("components", "map", "focus-header.tsx");
    const focusHeader = /<FocusHeader[\s\S]*?\/>/.exec(layout)?.[0] ?? "";
    expect(focusHeader).toContain('showPathToggle={variant !== "global"}');
    expect(layout.match(/showPathToggle=/g)).toHaveLength(1);
    // the toggle renders only behind the prop, which defaults on (the Command Map and Mission mode pass nothing)
    expect(header).toMatch(/showPathToggle = true,/);
    expect(header).toMatch(/\{showPathToggle && \(\s*<button type="button" className="btn ml-auto" aria-pressed=\{showPath\} onClick=\{onToggleShowPath\}>\s*Show Mission Path\s*<\/button>\s*\)\}/);
    expect(header.match(/Show Mission Path/g)).toHaveLength(1);
    // Exit keeps the right edge when the toggle is gone
    expect(header).toContain('className={cn("btn", !showPathToggle && "ml-auto")} onClick={onExit}');
  });
});
