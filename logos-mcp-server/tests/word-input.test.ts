import { describe, it, expect } from "vitest";
import { parseWordInput, validateWord, MAX_WORD_CHARS } from "../src/utils/word-input.js";

describe("validateWord", () => {
  it("trims and keeps Greek and Hebrew", () => {
    expect(validateWord("  hope ")).toBe("hope");
    expect(validateWord("ἀγάπη")).toBe("ἀγάπη");
    expect(validateWord("g:agape")).toBe("g:agape");
  });
  it("refuses empty input, line breaks, control characters and long input", () => {
    expect(() => validateWord("   ")).toThrow(/Give a word/);
    expect(() => validateWord("g:")).toThrow(/after the g: or h: prefix/);
    expect(() => validateWord(" h: ")).toThrow(/after the g: or h: prefix/);
    expect(() => validateWord("love\nGod")).toThrow(/control character/);
    expect(() => validateWord("a\tb")).toThrow(/control character/);
    expect(() => validateWord("a" + String.fromCharCode(0x2028) + "b")).toThrow(/control character/);
    expect(() => validateWord("x".repeat(MAX_WORD_CHARS + 1))).toThrow(/longer than/);
    expect(validateWord("x".repeat(MAX_WORD_CHARS))).toHaveLength(MAX_WORD_CHARS);
  });
});

describe("parseWordInput", () => {
  it("reads the g: and h: prefixes", () => {
    expect(parseWordInput("g:agape")).toEqual({ lemma: "g", term: "agape" });
    expect(parseWordInput(" H: hesed ")).toEqual({ lemma: "h", term: "hesed" });
    expect(parseWordInput("hope")).toEqual({ lemma: null, term: "hope" });
  });
});
