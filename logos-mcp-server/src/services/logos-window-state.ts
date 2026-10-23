/**
 * logos-window-state.ts
 *
 * What Logos is showing, for get_logos_state: window titles and, on Windows,
 * open tab names. macOS lists windows through a compiled Objective-C helper
 * (CGWindowList; AppleScript, Python, JXA and Swift all failed for Logos's
 * CEF-based windows). Windows uses PowerShell UI Automation helpers.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { isLogosRunning } from "./logos-app.js";
import { UTF8_SETUP, powershellFileArgs, runPowerShell, writeHelperScript } from "./powershell.js";
import { LOGOS_WINDOW_FINDER } from "./logos-window.js";
import { HELPER_CACHE_DIR, WINDOW_HELPER_BIN, WINDOW_HELPER_SRC } from "../config.js";
import type { LogosWindow, LogosWindowState } from "../types.js";

const execFileAsync = promisify(execFile);

// ─── Objective-C helper source ──────────────────────────────────────────────

const OBJ_C_SOURCE = `
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        CFArrayRef windowList = CGWindowListCopyWindowInfo(
            kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID
        );
        if (!windowList) {
            fprintf(stderr, "Failed to get window list (screen capture permission needed)\\n");
            return 1;
        }
        NSArray *windows = (NSArray *)windowList;
        NSMutableArray *results = [NSMutableArray array];
        for (NSDictionary *window in windows) {
            NSString *ownerName = window[@"kCGWindowOwnerName"];
            if ([ownerName containsString:@"Logos"]) {
                NSDictionary *bounds = window[@"kCGWindowBounds"];
                [results addObject:@{
                    @"owner": ownerName ?: @"",
                    @"windowID": window[@"kCGWindowNumber"] ?: @0,
                    @"x": bounds[@"X"] ?: @0,
                    @"y": bounds[@"Y"] ?: @0,
                    @"width": bounds[@"Width"] ?: @0,
                    @"height": bounds[@"Height"] ?: @0,
                    @"layer": window[@"kCGWindowLayer"] ?: @0,
                    @"name": window[@"kCGWindowName"] ?: @""
                }];
            }
        }
        CFRelease(windowList);
        NSData *jsonData = [NSJSONSerialization dataWithJSONObject:results options:0 error:nil];
        printf("%s\\n", [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding].UTF8String);
    }
    return 0;
}
`;

// ─── Helper compilation ─────────────────────────────────────────────────────

async function ensureHelper(): Promise<void> {
  if (!existsSync(WINDOW_HELPER_BIN)) {
    mkdirSync(HELPER_CACHE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(WINDOW_HELPER_SRC, OBJ_C_SOURCE);
    await execFileAsync("clang", [
      "-framework", "CoreGraphics",
      "-framework", "Foundation",
      "-o", WINDOW_HELPER_BIN,
      WINDOW_HELPER_SRC,
    ]);
  }
}

// ─── Window discovery ───────────────────────────────────────────────────────

async function getLogosWindows(): Promise<LogosWindow[]> {
  await ensureHelper();
  const { stdout } = await execFileAsync(WINDOW_HELPER_BIN);
  return JSON.parse(stdout.trim()) as LogosWindow[];
}

/**
 * Titles (kCGWindowName) of all currently open Logos windows, for use by a
 * `get_logos_state` tool. Never throws — returns an empty array if Logos
 * isn't running or the window helper fails.
 */
export async function getLogosWindowTitles(): Promise<string[]> {
  try {
    const running = await isLogosRunning();
    if (!running) return [];
    const windows = await getLogosWindows();
    return windows.map((w) => w.name).filter((name): name is string => Boolean(name));
  } catch {
    return [];
  }
}

// ─── Windows titles and tabs ────────────────────────────────────────────────

/**
 * Titles of the Logos and Verbum main-window candidates, largest first, one
 * per line (I16: not MainWindowTitle, which a hover popup can blank). Ends
 * with `exit 0`: when only one of the two process names exists, Get-Process
 * records a (suppressed) error and powershell.exe could otherwise exit 1
 * despite valid output (robrawks#9).
 */
export const WINDOWS_TITLES_SOURCE = String.raw`${UTF8_SETUP}
$ErrorActionPreference = "Stop"
${LOGOS_WINDOW_FINDER}
foreach ($w in (Select-LogosWindows (Get-LogosWindows))) { [Console]::Out.WriteLine($w.Title) }
exit 0
`;

/** Names of the TabItem elements under the Logos main window (W2), as a JSON array. */
export const WINDOWS_TABS_SOURCE = String.raw`${UTF8_SETUP}
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
${LOGOS_WINDOW_FINDER}
$win = Find-LogosMainWindow
if (-not $win) { [Console]::Out.WriteLine("[]"); exit 0 }
$root = [Windows.Automation.AutomationElement]::FromHandle($win.Handle)
$cond = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ClassNameProperty, "TabItem")
$names = @($root.FindAll([Windows.Automation.TreeScope]::Descendants, $cond) | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $names -Compress))
exit 0
`;

/**
 * Window titles from the titles command's output.
 *
 * @param stdout - One title per line.
 * @returns Non-empty, trimmed titles.
 */
export function parseTitleLines(stdout: string): string[] {
  return stdout.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
}

/**
 * Tab names from the tabs script's JSON line.
 *
 * @param stdout - The script's stdout.
 * @returns The names.
 * @throws When the output is not a JSON array of strings.
 */
export function parseTabNames(stdout: string): string[] {
  const parsed: unknown = JSON.parse(stdout.trim());
  if (!Array.isArray(parsed)) throw new Error("tab list is not an array");
  return parsed.filter((n): n is string => typeof n === "string");
}

async function windowsTitles(): Promise<string[]> {
  const script = writeHelperScript("logos-titles.ps1", WINDOWS_TITLES_SOURCE);
  const result = await runPowerShell(powershellFileArgs(script), { timeoutMs: 15_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `exit code ${result.exitCode}`);
  return parseTitleLines(result.stdout);
}

async function windowsTabs(): Promise<string[]> {
  const script = writeHelperScript("logos-tabs.ps1", WINDOWS_TABS_SOURCE);
  const result = await runPowerShell(powershellFileArgs(script), { timeoutMs: 15_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `exit code ${result.exitCode}`);
  return parseTabNames(result.stdout);
}

/** The readers getLogosWindowState uses; tests pass fakes. */
export interface WindowStateDeps {
  windowsTitles(): Promise<string[]>;
  windowsTabs(): Promise<string[]>;
  macTitles(): Promise<string[]>;
}

const DEFAULT_WINDOW_STATE_DEPS: WindowStateDeps = { windowsTitles, windowsTabs, macTitles: getLogosWindowTitles };

/**
 * Window titles (macOS and Windows) and open tabs (Windows) for
 * get_logos_state. Each part may fail on its own; it is then null. Never
 * throws.
 *
 * @param platform - Defaults to the running platform.
 * @param deps - The readers; defaults to the real PowerShell and macOS ones.
 * @returns What could be read.
 */
export async function getLogosWindowState(
  platform: NodeJS.Platform = process.platform,
  deps: WindowStateDeps = DEFAULT_WINDOW_STATE_DEPS
): Promise<LogosWindowState> {
  if (platform === "win32") {
    const [titles, tabs] = await Promise.all([
      deps.windowsTitles().catch(() => null),
      deps.windowsTabs().catch(() => null),
    ]);
    return { titles, tabs };
  }
  if (platform === "darwin") return { titles: await deps.macTitles().catch(() => []), tabs: null };
  return { titles: null, tabs: null };
}
