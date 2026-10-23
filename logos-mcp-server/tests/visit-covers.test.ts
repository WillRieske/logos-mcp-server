import { describe, it, expect } from "vitest";
import { visitCovers } from "../src/services/study-data.js";
import type { HistoryVisit } from "../src/types.js";

const visit = (rawReference: string | null): HistoryVisit => ({
  id: "1",
  title: "PNTC Jn",
  subtitle: null,
  lastVisited: "2026-10-17T07:00:00Z",
  kind: "Resource",
  resourceId: "LLS:29.48.20",
  rawReference,
  reference: null,
});

describe("visitCovers", () => {
  it("is true when the visit starts at the passage start", () => {
    expect(visitCovers(visit("bible.64.5.1"), "John 5:1")).toBe(true);
  });

  it("is true for a commentary label's range that contains the start (W19)", () => {
    expect(visitCovers(visit("bible.64.5.3.a-64.5.29"), "John 5:4")).toBe(true);
  });

  it("treats a chapter-only visit as the whole chapter", () => {
    expect(visitCovers(visit("bible.64.5"), "John 5:14")).toBe(true);
  });

  it("is false for a location that doesn't cover the start", () => {
    expect(visitCovers(visit("bible.64.6.1"), "John 5:1")).toBe(false);
    expect(visitCovers(visit("bible.64.5.3.a-64.5.29"), "John 5:30")).toBe(false);
    expect(visitCovers(visit("bible.65.5.1"), "John 5:1")).toBe(false);
  });

  it("is null when there is nothing to check", () => {
    expect(visitCovers(visit(null), "John 5:1")).toBeNull();
    expect(visitCovers(visit("page.9-13"), "John 5:1")).toBeNull();
    expect(visitCovers(visit("bible.64.5.1"), "not a reference")).toBeNull();
  });
});
