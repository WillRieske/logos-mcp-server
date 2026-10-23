import { describe, it, expect } from "vitest";
import {
  WINDOWS_TABS_SOURCE,
  WINDOWS_TITLES_SOURCE,
  parseTitleLines,
  parseTabNames,
  getLogosWindowState,
  type WindowStateDeps,
} from "../src/services/logos-window-state.js";
import { UTF8_SETUP } from "../src/services/powershell.js";

describe("parseTitleLines", () => {
  it("keeps non-empty, trimmed lines", () => {
    expect(parseTitleLines("Logos Free Edition\r\n\r\n  Verbum  \r\n")).toEqual(["Logos Free Edition", "Verbum"]);
    expect(parseTitleLines("")).toEqual([]);
  });
});

describe("parseTabNames", () => {
  it("reads the JSON array of tab names", () => {
    expect(parseTabNames('["Today","The Gospel according to John"]\r\n')).toEqual(["Today", "The Gospel according to John"]);
    expect(parseTabNames("[]")).toEqual([]);
  });

  it("rejects anything else", () => {
    expect(() => parseTabNames('"Today"')).toThrow();
    expect(() => parseTabNames("")).toThrow();
  });
});

describe("WINDOWS_TABS_SOURCE", () => {
  it("lists TabItem names under the Logos or Verbum main window (W2)", () => {
    expect(WINDOWS_TABS_SOURCE).toContain("-Name Logos, Verbum");
    expect(WINDOWS_TABS_SOURCE).toContain('"TabItem"');
    expect(WINDOWS_TABS_SOURCE).toContain("ConvertTo-Json -InputObject $names -Compress");
  });
});

describe("WINDOWS_TITLES_SOURCE", () => {
  it("sets both console encodings first and always exits 0", () => {
    expect(WINDOWS_TITLES_SOURCE.startsWith(UTF8_SETUP)).toBe(true);
    expect(WINDOWS_TITLES_SOURCE.trimEnd().endsWith("exit 0")).toBe(true);
  });
});

describe("getLogosWindowState", () => {
  const fail = async (): Promise<string[]> => {
    throw new Error("powershell blocked");
  };
  const deps = (overrides: Partial<WindowStateDeps> = {}): WindowStateDeps => ({
    windowsTitles: async () => ["Logos"],
    windowsTabs: async () => ["Today"],
    macTitles: async () => ["Logos", "John 5"],
    ...overrides,
  });

  it("reads titles and tabs on Windows", async () => {
    expect(await getLogosWindowState("win32", deps())).toEqual({ titles: ["Logos"], tabs: ["Today"] });
  });

  it("keeps one Windows part when the other fails", async () => {
    expect(await getLogosWindowState("win32", deps({ windowsTabs: fail }))).toEqual({ titles: ["Logos"], tabs: null });
    expect(await getLogosWindowState("win32", deps({ windowsTitles: fail }))).toEqual({ titles: null, tabs: ["Today"] });
    expect(await getLogosWindowState("win32", deps({ windowsTitles: fail, windowsTabs: fail }))).toEqual({ titles: null, tabs: null });
  });

  it("reads only titles on macOS, and never throws there", async () => {
    expect(await getLogosWindowState("darwin", deps())).toEqual({ titles: ["Logos", "John 5"], tabs: null });
    expect(await getLogosWindowState("darwin", deps({ macTitles: fail }))).toEqual({ titles: [], tabs: null });
  });

  it("reads nothing elsewhere", async () => {
    expect(await getLogosWindowState("linux", deps({ windowsTitles: fail, macTitles: fail }))).toEqual({ titles: null, tabs: null });
  });
});
