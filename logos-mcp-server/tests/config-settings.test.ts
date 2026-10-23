import { describe, it, expect } from "vitest";
import { join } from "path";
import {
  parseFlag,
  parseListenerSetting,
  DRIVER_LIMITS,
  UI_LOCK_LIMITS,
  WORD_STUDY_LIMITS,
  HELPER_CACHE_DIR,
  SETTINGS_PATH,
} from "../src/config.js";

describe("parseFlag", () => {
  it("is off for false, 0, no and off, in any case and with spaces", () => {
    for (const v of ["false", "0", "no", "off", " FALSE "]) expect(parseFlag(v, true)).toBe(false);
  });

  it("is on for true, 1, yes and on", () => {
    for (const v of ["true", "1", "yes", "on", "On"]) expect(parseFlag(v, false)).toBe(true);
  });

  it("uses the fallback when unset, empty or unrecognised", () => {
    expect(parseFlag(undefined, true)).toBe(true);
    expect(parseFlag("", false)).toBe(false);
    expect(parseFlag("maybe", true)).toBe(true);
  });
});

describe("parseListenerSetting", () => {
  it("reads ask, on and off", () => {
    expect(parseListenerSetting("ask")).toBe("ask");
    expect(parseListenerSetting(" ON ")).toBe("on");
    expect(parseListenerSetting("off")).toBe("off");
  });

  it("defaults to ask", () => {
    expect(parseListenerSetting(undefined)).toBe("ask");
    expect(parseListenerSetting("sometimes")).toBe("ask");
  });
});

describe("DRIVER_LIMITS and UI_LOCK_LIMITS", () => {
  it("hold the driver's limits and timing, with nothing left over from copying", () => {
    expect(DRIVER_LIMITS).toEqual({
      commandTimeoutMs: 5_000,
      initTimeoutMs: 15_000,
      uiaTimeoutMs: 15_000,
      closeGraceMs: 1_000,
      cursorTolerancePx: 3,
      driverTiming: { keyStepMs: 40, enterReleaseMs: 150, typeStepMs: 30, focusSettleMs: 200 },
    });
  });

  it("holds the UI lock for 60 s at most, word study's own hold", () => {
    expect(UI_LOCK_LIMITS).toEqual({ maxHoldMs: 60_000, settleMs: 2_000 });
    expect(UI_LOCK_LIMITS.maxHoldMs).toBe(WORD_STUDY_LIMITS.lockMaxHoldMs);
  });
});

describe.runIf(process.platform === "win32")("server data paths on Windows", () => {
  it("keeps the helper cache and settings under %LOCALAPPDATA%\\logos-mcp", () => {
    const base = join(process.env.LOCALAPPDATA as string, "logos-mcp");
    expect(HELPER_CACHE_DIR).toBe(join(base, "cache"));
    expect(SETTINGS_PATH).toBe(join(base, "settings.json"));
  });
});
