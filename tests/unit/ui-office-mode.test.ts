import { describe, expect, it } from "vitest";
import { DEFAULT_OFFICE_MODE, OFFICE_MODE_KEY, parseOfficeMode, readOfficeMode, writeOfficeMode } from "@/lib/ui/office-mode";

const memoryStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), raw: m };
};
const boom = () => {
  throw new Error("SecurityError");
};

describe("parseOfficeMode", () => {
  it("defaults first-time viewers to the Global Office", () => {
    expect(DEFAULT_OFFICE_MODE).toBe("global");
  });
  it("maps the two stored values exactly", () => {
    expect(parseOfficeMode("global")).toBe("global");
    expect(parseOfficeMode("mission")).toBe("mission");
  });
  it.each([null, undefined, "", "Mission", "MISSION", " mission", "mission ", "true", "1", 1, {}, ["mission"], '"mission"'])("treats %j as the default", (raw) => {
    expect(parseOfficeMode(raw)).toBe("global");
  });
});

describe("readOfficeMode / writeOfficeMode", () => {
  it("round-trips a choice under bcc.office.mode", () => {
    const s = memoryStorage();
    expect(readOfficeMode(s)).toBe("global");
    expect(writeOfficeMode(s, "mission")).toBe(true);
    expect(s.raw.get(OFFICE_MODE_KEY)).toBe("mission");
    expect(OFFICE_MODE_KEY).toBe("bcc.office.mode");
    expect(readOfficeMode(s)).toBe("mission");
    expect(writeOfficeMode(s, "global")).toBe(true);
    expect(readOfficeMode(s)).toBe("global");
  });
  it("reads a garbage stored value as the default", () => {
    const s = memoryStorage();
    s.setItem(OFFICE_MODE_KEY, "{\"mode\":\"mission\"}");
    expect(readOfficeMode(s)).toBe("global");
  });
  it("survives a missing storage and storage that throws on read or write", () => {
    expect(readOfficeMode(null)).toBe("global");
    expect(writeOfficeMode(null, "mission")).toBe(false);
    expect(readOfficeMode({ getItem: boom })).toBe("global");
    expect(writeOfficeMode({ setItem: boom }, "mission")).toBe(false);
  });
});
