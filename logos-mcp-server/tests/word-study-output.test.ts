import { describe, it, expect } from "vitest";
import {
  formatWordStudyError,
  wordStudyEmptyText,
  wordStudyResultText,
  wordStudyTypingSupported,
} from "../src/utils/word-study-output.js";
import { wordStudyWithConsent } from "../src/services/word-study-tool.js";
import type { WordStudyResult } from "../src/services/word-study.js";

const base: WordStudyResult = { word: "hope", status: "ran", stage: "entered", recorded: "hope", listener: "off", warnings: [] };

describe("wordStudyTypingSupported", () => {
  it("is Windows with the current link style only", () => {
    expect(wordStudyTypingSupported("win32", "current")).toBe(true);
    expect(wordStudyTypingSupported("win32", "legacy")).toBe(false);
    expect(wordStudyTypingSupported("darwin", "current")).toBe(false);
    expect(wordStudyTypingSupported("linux", "current")).toBe(false);
  });
});

describe("wordStudyResultText", () => {
  it("reports a confirmed run with what Logos recorded", () => {
    const text = wordStudyResultText(base);
    expect(text).toContain('Ran Bible Word Study for "hope"');
    expect(text).toContain("recorded the study (hope)");
    expect(text).toContain("no data is returned");
  });

  it("does not claim success for a different, unconfirmed or unverifiable run", () => {
    expect(wordStudyResultText({ ...base, status: "different", recorded: "grace" })).toContain('recorded "grace" instead');
    expect(wordStudyResultText({ ...base, status: "unconfirmed", recorded: undefined })).toContain("can't be confirmed");
    expect(wordStudyResultText({ ...base, status: "unavailable", recorded: undefined })).toContain("could not be read");
    for (const status of ["different", "unconfirmed", "unavailable"] as const) {
      expect(wordStudyResultText({ ...base, status })).not.toMatch(/^Ran /);
    }
  });

  it("says how far an interrupted run got", () => {
    const stopped = (stage: WordStudyResult["stage"]) =>
      wordStudyResultText({ ...base, status: "interrupted", stage, reason: "time limit reached" });
    expect(stopped("none")).toBe("Stopped: time limit reached. Nothing was opened.");
    expect(stopped("launching")).toContain("may be open");
    expect(stopped("opened")).toContain("nothing was typed");
    expect(stopped("typing")).toContain("Enter was not pressed");
    expect(stopped("entering")).toContain("may have run");
  });

  it("lists warnings", () => {
    expect(wordStudyResultText({ ...base, warnings: ["a", "b"] })).toContain("Notes:\n- a\n- b");
  });
});

describe("other replies", () => {
  it("asks the user to type where typing isn't supported", () => {
    expect(wordStudyEmptyText("agape")).toContain('type "agape"');
  });
  it("formats an error with its warnings", () => {
    expect(formatWordStudyError({ message: "boom", warnings: ["x"] })).toBe("boom\nAlso: x");
  });
});

describe("wordStudyWithConsent", () => {
  it("passes consent to the run and appends the consent note", async () => {
    let seen: boolean | null = null;
    const result = await wordStudyWithConsent(
      { word: "hope" },
      {
        consent: async () => ({ listener: false, source: "fallback", note: "set LOGOS_INPUT_LISTENER=on" }),
        run: async (request) => {
          seen = request.listenerConsent;
          return base;
        },
      }
    );
    expect(seen).toBe(false);
    expect(result.warnings).toEqual(["set LOGOS_INPUT_LISTENER=on"]);
  });
});
