// tests/terms-compliance.test.ts
// Guards the removals the Logos terms require: no tool may hand Logos book
// text to the assistant, by copy, screen capture or screen reading.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { makeFixtureDirs, cleanupFixtureDirs, type FixtureDirs } from "./helpers/fixtures.js";
import { startServer } from "./helpers/server.js";
import { REMOVED_DRIVER_COMMANDS } from "./helpers/removed-driver-commands.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function srcPath(rel: string): string {
  return join(SRC, rel);
}

function sourceFiles(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

function allSourceText(): string {
  return sourceFiles().map((f) => readFileSync(f, "utf8")).join("\n");
}

const WITHDRAWN_TOOLS = ["copy_resource_text", "capture_panel_screenshot"];
const WITHDRAWN_MODULES = [
  "services/text-copy.ts",
  "services/copy-tool.ts",
  "utils/copy-text.ts",
  "utils/copy-output.ts",
  "services/ui-driver-macos.ts",
  "utils/copy-geometry.ts",
  "services/screenshot-capture.ts",
];

describe("terms compliance", () => {
  let dirs: FixtureDirs;
  let client: Client;

  beforeAll(async () => {
    dirs = makeFixtureDirs();
    client = await startServer(dirs, { LOCALAPPDATA: dirs.dataDir, HOME: dirs.dataDir, USERPROFILE: dirs.dataDir });
  }, 30_000);
  afterAll(async () => {
    await client.close();
    cleanupFixtureDirs(dirs);
  });

  async function listTools() {
    return (await client.listTools()).tools;
  }

  it("registers none of the withdrawn tools", async () => {
    const names = (await listTools()).map((t) => t.name);
    for (const tool of WITHDRAWN_TOOLS) expect(names).not.toContain(tool);
  });

  it("no tool description points the assistant at a withdrawn tool", async () => {
    for (const t of await listTools()) {
      for (const tool of WITHDRAWN_TOOLS) expect(t.description ?? "", t.name).not.toContain(tool);
    }
  });

  it("the extraction modules are gone", () => {
    for (const rel of WITHDRAWN_MODULES) expect(existsSync(srcPath(rel)), rel).toBe(false);
  });

  it("the input driver has no clipboard, mouse or panel-reading commands", async () => {
    const { WINDOWS_DRIVER_SOURCE } = await import("../src/services/ui-driver-windows.js");
    // A switch case, quoted either way or bare: "copy" {, 'copy' { or copy {
    for (const cmd of REMOVED_DRIVER_COMMANDS) {
      expect(WINDOWS_DRIVER_SOURCE, cmd).not.toMatch(new RegExp(String.raw`^\s*["']?${cmd}["']?\s*\{`, "m"));
    }
    // The only mouse input left is inputCheck's zero-distance move.
    expect(WINDOWS_DRIVER_SOURCE.match(/::Mouse\(([^)]*)\)/g)).toEqual(["::Mouse(1, 0)"]);
    expect(WINDOWS_DRIVER_SOURCE).not.toContain("Windows.Forms.Clipboard");
    expect(WINDOWS_DRIVER_SOURCE).not.toContain("TextPattern");
  });

  it("no source reads the clipboard", () => {
    const text = allSourceText();
    expect(text).not.toMatch(/readClipboard|Clipboard\]::GetText|GetDataObject/);
  });

  it("no source mentions a withdrawn tool", () => {
    const text = allSourceText();
    for (const tool of WITHDRAWN_TOOLS) expect(text).not.toContain(tool);
  });

  it("no source captures the screen", () => {
    expect(allSourceText()).not.toMatch(/PrintWindow|screencapture|CopyFromScreen|BitBlt/);
  });

  it("no tool returns an image", () => {
    expect(allSourceText()).not.toMatch(/mimeType: "image\//);
  });

  it("registers exactly the remaining tools", async () => {
    const names = (await listTools()).map((t) => t.name).sort();
    expect(names).toEqual([
      "compare_passages", "diagnose", "find_passage_resources", "get_available_bibles", "get_bible_text",
      "get_clippings", "get_cross_references", "get_favorites", "get_library_catalog", "get_logos_state",
      "get_passage_context", "get_passage_lists", "get_reading_history", "get_reading_progress",
      "get_resource_reading_progress", "get_resource_types", "get_study_workflows", "get_user_highlights",
      "get_user_notes", "navigate_passage", "open_factbook", "open_guide", "open_resource", "open_word_study",
      "scan_references", "search_all", "search_bible",
    ]);
  });

  it("no tool description mentions screenshots", async () => {
    for (const t of await listTools()) expect(t.description ?? "", t.name).not.toMatch(/screenshot/i);
  });
});
