import { describe, it, expect } from "vitest";
import {
  uiFollowUpHint,
  logosStateText,
  formatKnowledgeChoices,
  windowTitlesAvailable,
  openConfirmationText,
} from "../src/utils/tool-text.js";
import type { KnowledgeEntry } from "../src/types.js";

describe("windowTitlesAvailable", () => {
  it("is true on macOS and Windows", () => {
    expect(windowTitlesAvailable("darwin")).toBe(true);
    expect(windowTitlesAvailable("win32")).toBe(true);
    expect(windowTitlesAvailable("linux")).toBe(false);
  });
});

describe("uiFollowUpHint", () => {
  it("suggests confirming with window titles on macOS and Windows", () => {
    const hint = " Call get_logos_state to confirm what Logos is showing.";
    expect(uiFollowUpHint("darwin")).toBe(hint);
    expect(uiFollowUpHint("win32")).toBe(hint);
  });

  it("suggests nothing where those tools don't work", () => {
    expect(uiFollowUpHint("linux")).toBe("");
  });
});

describe("logosStateText", () => {
  it("lists window titles on macOS", () => {
    expect(logosStateText({ titles: ["Logos", "John 5"], tabs: null }, "darwin")).toBe("Logos is running. Window titles:\n- Logos\n- John 5");
    expect(logosStateText({ titles: [], tabs: null }, "darwin")).toBe("Logos is running. Window titles:\n- (no named windows found)");
  });

  it("lists titles and open tabs on Windows", () => {
    expect(
      logosStateText({ titles: ["Logos Free Edition"], tabs: ["Today", "The Gospel according to John", "The Lexham English Bible"] }, "win32")
    ).toBe("Logos is running. Window titles:\n- Logos Free Edition\nOpen tabs: Today | The Gospel according to John | The Lexham English Bible");
  });

  it("reports what it has when one part fails", () => {
    expect(logosStateText({ titles: ["Logos"], tabs: null }, "win32")).toBe("Logos is running. Window titles:\n- Logos\nOpen tabs: (tabs unavailable)");
    expect(logosStateText({ titles: null, tabs: ["Today"] }, "win32")).toBe("Logos is running. Window titles:\n- (titles unavailable)\nOpen tabs: Today");
    expect(logosStateText({ titles: [], tabs: [] }, "win32")).toBe("Logos is running. Window titles:\n- (no named windows found)\nOpen tabs: (none)");
  });

  it("says titles are unavailable elsewhere instead of implying none are open", () => {
    expect(logosStateText({ titles: [], tabs: null }, "linux")).toBe("Logos is running. Window titles are not available on this platform.");
  });
});

describe("formatKnowledgeChoices", () => {
  it("lists each entry with its ID and kind, never a description", () => {
    const withDescription = { id: "bk.#Moses", label: "Moses", kind: "Man", description: "Invented description" } as KnowledgeEntry;
    expect(
      formatKnowledgeChoices([
        withDescription,
        { id: "bk.to:DBT-5333", label: "Healing", kind: "PreachingTheme" },
        { id: "bk.%X", label: "X", kind: null },
      ])
    ).toBe("- `bk.#Moses` — Moses (Man)\n- `bk.to:DBT-5333` — Healing (PreachingTheme)\n- `bk.%X` — X");
  });
});

describe("openConfirmationText", () => {
  const visit = {
    id: "h1",
    title: "PNTC Jn",
    subtitle: "John 5:14",
    lastVisited: "2026-10-15T06:58:20Z",
    kind: "Resource",
    resourceId: "LLS:29.48.20",
    rawReference: "bible.64.5.14",
    reference: "John 5:14",
  };
  const guideVisit = { ...visit, title: "Exegetical Guide", kind: "Guides", resourceId: null, rawReference: null, reference: null };

  it("reports what Logos opened", () => {
    expect(openConfirmationText({ status: "confirmed", visit }, "resource `LLS:29.48.20`", "win32")).toBe(
      "Opened PNTC Jn at John 5:14 in Logos. This only opens the Logos UI on the user's screen — no data is returned to you."
    );
  });

  it("names a guide, Factbook entry or search with its subtitle in brackets", () => {
    expect(openConfirmationText({ status: "confirmed", visit: guideVisit }, "Exegetical Guide for John 5:14", "win32")).toBe(
      "Opened Exegetical Guide (John 5:14) in Logos. This only opens the Logos UI on the user's screen — no data is returned to you."
    );
    const sermonStarter = { ...guideVisit, title: "Sermon Starter Guide", subtitle: null };
    expect(openConfirmationText({ status: "confirmed", visit: sermonStarter }, "Sermon Starter Guide for Healing", "win32")).toBe(
      "Opened Sermon Starter Guide in Logos. This only opens the Logos UI on the user's screen — no data is returned to you."
    );
    const factbookVisit = { ...guideVisit, title: "Factbook | Sabbath", subtitle: null, kind: "Factbook" };
    expect(openConfirmationText({ status: "confirmed", visit: factbookVisit }, "Factbook entry Sabbath (`bk.%Sabbath`)", "win32")).toBe(
      "Opened Factbook | Sabbath in Logos. This only opens the Logos UI on the user's screen — no data is returned to you."
    );
    const searchVisit = { ...guideVisit, title: "Search", subtitle: "justification by faith | All", kind: "Search" };
    expect(openConfirmationText({ status: "confirmed", visit: searchVisit }, 'search for "justification by faith" across all resources', "win32")).toBe(
      "Opened Search (justification by faith | All) in Logos. This only opens the Logos UI on the user's screen — no data is returned to you."
    );
  });

  it("says when Logos was already showing the location", () => {
    expect(openConfirmationText({ status: "already_open", visit }, "resource `LLS:29.48.20`", "win32")).toBe(
      "Logos is already showing PNTC Jn at John 5:14. This only opens the Logos UI on the user's screen — no data is returned to you."
    );
    expect(openConfirmationText({ status: "already_open", visit: guideVisit }, "Exegetical Guide for John 5:14", "win32")).toBe(
      "Logos is already showing Exegetical Guide (John 5:14). This only opens the Logos UI on the user's screen — no data is returned to you."
    );
  });

  it("says when Logos did not confirm", () => {
    expect(openConfirmationText({ status: "unconfirmed" }, "resource `LLS:X`", "win32")).toBe(
      "Sent resource `LLS:X` to Logos, but Logos did not confirm opening it — Logos may be busy; try again once it responds."
    );
  });

  it("falls back to the plain dispatch message without a history store", () => {
    expect(openConfirmationText({ status: "unavailable" }, "resource `LLS:X`", "linux")).toBe(
      "Dispatched to Logos: resource `LLS:X`. This only opens the Logos UI on the user's screen — no data is returned to you."
    );
  });
});
