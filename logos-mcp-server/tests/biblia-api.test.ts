import { describe, it, expect } from "vitest";
import { normalizeResultCount } from "../src/services/biblia-api.js";

describe("normalizeResultCount", () => {
  it("uses the reported count when it is a non-negative number", () => {
    expect(normalizeResultCount(42, 5)).toBe(42);
    expect(normalizeResultCount(0, 5)).toBe(0);
  });

  it("falls back to the result length when Biblia reports -1 (unknown total)", () => {
    expect(normalizeResultCount(-1, 5)).toBe(5);
  });

  it("falls back to the result length for null/undefined", () => {
    expect(normalizeResultCount(null, 3)).toBe(3);
    expect(normalizeResultCount(undefined, 3)).toBe(3);
  });
});
