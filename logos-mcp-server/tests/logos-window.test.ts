import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LOGOS_WINDOW_FINDER } from "../src/services/logos-window.js";
import { WINDOWS_TABS_SOURCE, WINDOWS_TITLES_SOURCE } from "../src/services/logos-window-state.js";
import { WINDOWS_DRIVER_SOURCE } from "../src/services/ui-driver-windows.js";
import { UTF8_SETUP, powershellFileArgs, runPowerShell, writeHelperScript } from "../src/services/powershell.js";

// I16: a Logos hover popup became the process's MainWindowHandle, so every
// helper that finds the Logos window goes through LOGOS_WINDOW_FINDER instead.
const SCRIPTS: Record<string, string> = {
  tabs: WINDOWS_TABS_SOURCE,
  titles: WINDOWS_TITLES_SOURCE,
  driver: WINDOWS_DRIVER_SOURCE,
};

describe("LOGOS_WINDOW_FINDER", () => {
  it("contains no backtick, which would end the TypeScript template", () => {
    expect(LOGOS_WINDOW_FINDER.includes(String.fromCharCode(96))).toBe(false);
  });

  it("lists the windows of both Logos and Verbum and skips untitled, owned and tool windows", () => {
    expect(LOGOS_WINDOW_FINDER).toContain("Get-Process -Name Logos, Verbum");
    expect(LOGOS_WINDOW_FINDER).toContain("$_.Visible -and $_.Title -and -not $_.Owned -and -not $_.ToolWindow");
  });

  for (const [name, source] of Object.entries(SCRIPTS)) {
    it(`is what the ${name} script uses, never MainWindowHandle`, () => {
      expect(source).toContain(LOGOS_WINDOW_FINDER);
      expect(source).not.toMatch(/MainWindow(Handle|Title)/);
    });
  }

  it("lets the driver tell Logos's controls by process, not by MainWindowHandle", () => {
    expect(WINDOWS_DRIVER_SOURCE).toContain("$script:H = $w.Handle");
    expect(WINDOWS_DRIVER_SOURCE).toContain("$script:LogosPid = $w.ProcessId");
    expect(WINDOWS_DRIVER_SOURCE).toContain("[uint32]$el.Current.ProcessId -eq $script:LogosPid");
  });
});

// The choice itself (the marked block), run under Windows PowerShell with
// made-up windows: no real window is read.
describe.runIf(process.platform === "win32")("main window choice (Windows PowerShell)", () => {
  const START = "# >>> main window choice";
  const END = "# <<< main window choice";
  const win = (title: string, area: number, extra: Record<string, boolean> = {}) => ({
    Title: title,
    Area: area,
    Visible: true,
    Owned: false,
    ToolWindow: false,
    ...extra,
  });
  const SCENARIOS: Record<string, ReturnType<typeof win>[]> = {
    // 2026-10-19: the untitled hover popup came first in Z order.
    hoverPopupFirst: [win("", 90_000), win("Logos Free Edition", 1_400_000)],
    // Even a popup larger than the main window is not chosen.
    hugePopup: [win("", 9_000_000), win("Logos Bible Software", 1_400_000)],
    toolWindow: [win("Tooltip", 5_000_000, { ToolWindow: true }), win("Logos", 1_400_000)],
    ownedDialog: [win("Print", 5_000_000, { Owned: true }), win("Logos", 1_400_000)],
    hidden: [win("Logos", 5_000_000, { Visible: false }), win("Verbum", 1_400_000)],
    largestTitled: [win("John 5", 300_000), win("Logos", 1_400_000), win("Notes", 600_000)],
    onlyPopups: [win("", 90_000), win("Menu", 40_000, { ToolWindow: true })],
    none: [],
  };

  it("picks the largest visible, titled, unowned, non-tool window and nothing else", async () => {
    const start = LOGOS_WINDOW_FINDER.indexOf(START);
    const end = LOGOS_WINDOW_FINDER.indexOf(END);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = LOGOS_WINDOW_FINDER.slice(start, end);
    const literal = (w: ReturnType<typeof win>) =>
      `[pscustomobject]@{ Title = '${w.Title}'; Area = ${w.Area}; Visible = $${w.Visible}; Owned = $${w.Owned}; ToolWindow = $${w.ToolWindow} }`;
    const runs = Object.entries(SCENARIOS).map(
      ([name, windows]) =>
        `$picked = @(Select-LogosWindows @(${windows.map(literal).join(", ")})); $results['${name}'] = @($picked | ForEach-Object { $_.Title })`
    );
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$block = @'\n${block}\n'@`,
      ". ([scriptblock]::Create($block))",
      "$results = [ordered]@{}",
      ...runs,
      "[Console]::Out.Write(($results | ConvertTo-Json -Compress))",
    ].join("\r\n");
    const dir = mkdtempSync(join(tmpdir(), "logos-mcp-mainwin-"));
    try {
      const path = writeHelperScript("main-window-choice.ps1", script, dir);
      const result = await runPowerShell(powershellFileArgs(path), { timeoutMs: 30_000 });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        hoverPopupFirst: ["Logos Free Edition"],
        hugePopup: ["Logos Bible Software"],
        toolWindow: ["Logos"],
        ownedDialog: ["Logos"],
        hidden: ["Verbum"],
        largestTitled: ["Logos", "Notes", "John 5"],
        onlyPopups: [],
        none: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // Compiles the C# and reads the real window list: read-only, no input.
  // With Logos running it must name a window; without it, nothing.
  it("compiles and finds the main window, if Logos is running", async () => {
    const script = [
      UTF8_SETUP,
      "$ErrorActionPreference = 'Stop'",
      LOGOS_WINDOW_FINDER,
      "$running = @(Get-Process -Name Logos, Verbum -ErrorAction SilentlyContinue).Count -gt 0",
      "$w = Find-LogosMainWindow",
      "$out = [ordered]@{ running = $running; found = ($w -ne $null); title = ''; handle = 0 }",
      "if ($w) { $out.title = $w.Title; $out.handle = $w.Handle.ToInt64() }",
      "[Console]::Out.Write(($out | ConvertTo-Json -Compress))",
      "exit 0",
    ].join("\r\n");
    const dir = mkdtempSync(join(tmpdir(), "logos-mcp-findwin-"));
    try {
      const path = writeHelperScript("find-main-window.ps1", script, dir);
      const result = await runPowerShell(powershellFileArgs(path), { timeoutMs: 30_000 });
      expect(result.exitCode, result.stderr).toBe(0);
      const out = JSON.parse(result.stdout) as { running: boolean; found: boolean; title: string; handle: number };
      if (out.found) {
        expect(out.title).not.toBe("");
        expect(out.handle).not.toBe(0);
      }
      if (!out.running) expect(out.found).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
