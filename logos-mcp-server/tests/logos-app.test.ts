import { describe, it, expect } from "vitest";
import {
  isLogosRunning,
  launchLogosUrl,
  openUrl,
  tasklistHasLogos,
  FOCUS_HELPER_SOURCE,
  type OpenDeps,
} from "../src/services/logos-app.js";

function fakeDeps(overrides: Partial<OpenDeps> = {}): { deps: OpenDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: OpenDeps = {
    platform: "win32",
    restoreFocusDefault: true,
    focusHelper: async (url) => {
      calls.push(`helper ${url}`);
    },
    rundll32: async (url) => {
      calls.push(`rundll32 ${url}`);
    },
    macOpen: async (url) => {
      calls.push(`open ${url}`);
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("launchLogosUrl", () => {
  it("returns a failed result without launching when the link cannot be built", async () => {
    const result = await launchLogosUrl(() => {
      throw new Error('Cannot parse reference: "nonsense"');
    });
    expect(result).toEqual({ success: false, command: "", error: 'Cannot parse reference: "nonsense"' });
  });
});

describe("openUrl", () => {
  it("opens through the focus helper on Windows when focus restore is on", async () => {
    const { deps, calls } = fakeDeps();
    const result = await openUrl("logosres:LLS:LEB", {}, deps);
    expect(result).toEqual({ success: true, command: "logosres:LLS:LEB" });
    expect(calls).toEqual(["helper logosres:LLS:LEB"]);
  });

  it("falls back to rundll32 when the helper fails, so the link still opens", async () => {
    const { deps, calls } = fakeDeps({
      focusHelper: async () => {
        throw new Error("PowerShell is unavailable or blocked by policy.");
      },
    });
    const result = await openUrl("logosres:LLS:LEB", {}, deps);
    expect(result.success).toBe(true);
    expect(calls).toEqual(["rundll32 logosres:LLS:LEB"]);
  });

  it("skips the restore when restoreFocus is false, even with the setting on", async () => {
    const { deps, calls } = fakeDeps();
    await openUrl("logosres:LLS:LEB", { restoreFocus: false }, deps);
    expect(calls).toEqual(["rundll32 logosres:LLS:LEB"]);
  });

  it("skips the restore when LOGOS_RESTORE_FOCUS is off", async () => {
    const { deps, calls } = fakeDeps({ restoreFocusDefault: false });
    await openUrl("logosres:LLS:LEB", {}, deps);
    expect(calls).toEqual(["rundll32 logosres:LLS:LEB"]);
  });

  it("uses open on macOS", async () => {
    const { deps, calls } = fakeDeps({ platform: "darwin" });
    await openUrl("logosres:LLS:LEB", {}, deps);
    expect(calls).toEqual(["open logosres:LLS:LEB"]);
  });

  it("reports a launch failure", async () => {
    const { deps } = fakeDeps({
      restoreFocusDefault: false,
      rundll32: async () => {
        throw new Error("no handler");
      },
    });
    expect(await openUrl("logos4:x", {}, deps)).toEqual({ success: false, command: "logos4:x", error: "no handler" });
  });
});

describe("FOCUS_HELPER_SOURCE", () => {
  it("leaves focus alone when the user was already in Logos or Verbum", () => {
    expect(FOCUS_HELPER_SOURCE).toContain('-match "^(Logos|Verbum)$"');
  });

  it("waits 700 ms, then re-asserts the user's window for up to 1 s", () => {
    expect(FOCUS_HELPER_SOURCE).toContain("Start-Sleep -Milliseconds 700");
    expect(FOCUS_HELPER_SOURCE).toContain("for ($i = 0; $i -lt 5; $i++)");
  });
});

describe("tasklistHasLogos", () => {
  it("finds Logos.exe or Verbum.exe in tasklist CSV output", () => {
    expect(tasklistHasLogos('"svchost.exe","1","Services","0","9,000 K"\r\n"Logos.exe","42","Console","1","900,000 K"')).toBe(true);
    expect(tasklistHasLogos('"Verbum.exe","42","Console","1","900,000 K"')).toBe(true);
    expect(tasklistHasLogos('"LogosIndexer.exe","42","Console","1","9 K"')).toBe(false);
    expect(tasklistHasLogos("INFO: No tasks are running which match the specified criteria.")).toBe(false);
  });
});

// An unfiltered tasklist took 11 s on the Task 19 PC; filtered by image name, 0.5 s.
describe("isLogosRunning on Windows", () => {
  const NONE = "INFO: No tasks are running which match the specified criteria.";
  function fakeTasklist(listed: Record<string, string>): { run: (args: string[]) => Promise<string>; calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      run: async (args) => {
        calls.push(args);
        const name = args[args.indexOf("/FI") + 1]?.replace("IMAGENAME eq ", "") ?? "";
        return listed[name] ?? NONE;
      },
    };
  }

  it("asks tasklist for each image name separately instead of listing every process", async () => {
    const { run, calls } = fakeTasklist({ "Logos.exe": '"Logos.exe","42","Console","1","900,000 K"' });
    expect(await isLogosRunning("win32", run)).toBe(true);
    expect(calls).toEqual([
      ["/NH", "/FO", "CSV", "/FI", "IMAGENAME eq Logos.exe"],
      ["/NH", "/FO", "CSV", "/FI", "IMAGENAME eq Verbum.exe"],
    ]);
  });

  it("finds Verbum, and reports neither", async () => {
    expect(await isLogosRunning("win32", fakeTasklist({ "Verbum.exe": '"Verbum.exe","7","Console","1","9 K"' }).run)).toBe(true);
    expect(await isLogosRunning("win32", fakeTasklist({}).run)).toBe(false);
  });

  it("reports not running when tasklist fails", async () => {
    expect(await isLogosRunning("win32", async () => { throw new Error("no tasklist"); })).toBe(false);
  });
});
