import { execFile } from "child_process";
import { promisify } from "util";
import { LOGOS_RESTORE_FOCUS } from "../config.js";
import { UTF8_SETUP, powershellFileArgs, runPowerShell, writeHelperScript } from "./powershell.js";
import type { LogosCommandResult } from "../types.js";

const execFileAsync = promisify(execFile);

// Launching and "is Logos running" checks only; links are built in
// logos-urls.ts.

/**
 * Opens a link and, unless the user was already in Logos, gives the
 * foreground back to the window they were in (design §2; from robrawks#9).
 * Logos brings itself forward on every link; restoring before that settles
 * is overridden, so it waits 700 ms and re-asserts for up to 1 s. An Alt tap
 * lifts Windows' restriction on background processes taking focus. Once the
 * link has been sent the script always exits 0, so a later failure can't
 * make the caller send the link a second time.
 */
export const FOCUS_HELPER_SOURCE = String.raw`param([Parameter(Mandatory=$true)][string]$Url)
${UTF8_SETUP}
$ErrorActionPreference = "Stop"
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LogosMcpFocus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
'@
$before = [LogosMcpFocus]::GetForegroundWindow()
$beforePid = 0
[void][LogosMcpFocus]::GetWindowThreadProcessId($before, [ref]$beforePid)
$beforeName = ""
try { $beforeName = (Get-Process -Id $beforePid -ErrorAction Stop).ProcessName } catch {}
try { Start-Process $Url } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
try {
  if ($before -ne [IntPtr]::Zero -and -not ($beforeName -match "^(Logos|Verbum)$")) {
    Start-Sleep -Milliseconds 700
    for ($i = 0; $i -lt 5; $i++) {
      if ([LogosMcpFocus]::GetForegroundWindow() -ne $before) {
        [LogosMcpFocus]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
        [void][LogosMcpFocus]::SetForegroundWindow($before)
        [LogosMcpFocus]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
      }
      Start-Sleep -Milliseconds 200
      if ([LogosMcpFocus]::GetForegroundWindow() -eq $before) { break }
    }
  }
} catch {}
exit 0
`;

/** How `openUrl` reaches the OS; replaced in tests. */
export interface OpenDeps {
  platform: NodeJS.Platform;
  /** LOGOS_RESTORE_FOCUS. */
  restoreFocusDefault: boolean;
  /** Opens the link and restores focus; throws when the helper fails before sending it. */
  focusHelper(url: string): Promise<void>;
  rundll32(url: string): Promise<void>;
  macOpen(url: string): Promise<void>;
}

const defaultOpenDeps: OpenDeps = {
  platform: process.platform,
  restoreFocusDefault: LOGOS_RESTORE_FOCUS,
  async focusHelper(url) {
    const script = writeHelperScript("open-logos-link.ps1", FOCUS_HELPER_SOURCE);
    const result = await runPowerShell(powershellFileArgs(script, ["-Url", url]), { timeoutMs: 15_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `exit code ${result.exitCode}`);
  },
  async rundll32(url) {
    // rundll32 takes the URL as one argument — avoids cmd.exe mangling
    // the `&` in query strings that `start` would require escaping for.
    await execFileAsync("rundll32", ["url.dll,FileProtocolHandler", url]);
  },
  async macOpen(url) {
    await execFileAsync("open", [url]);
  },
};

/**
 * Hands a link to the OS. On Windows, with focus restore on, the link goes
 * through the focus helper; if the helper fails, rundll32 opens it without
 * the restore.
 *
 * @param url - The Logos link.
 * @param options.restoreFocus - Defaults to LOGOS_RESTORE_FOCUS; false for
 *   callers that need Logos in front (word-study typing).
 * @param deps - OS access; replaced in tests.
 * @returns Whether the link was sent.
 */
export async function openUrl(
  url: string,
  options: { restoreFocus?: boolean } = {},
  deps: OpenDeps = defaultOpenDeps
): Promise<LogosCommandResult> {
  try {
    if (deps.platform === "win32") {
      const restore = options.restoreFocus ?? deps.restoreFocusDefault;
      let sent = false;
      if (restore) {
        try {
          await deps.focusHelper(url);
          sent = true;
        } catch {
          // PowerShell unavailable or the helper failed before sending the
          // link — open it without the restore.
        }
      }
      if (!sent) await deps.rundll32(url);
    } else {
      await deps.macOpen(url);
    }
    return { success: true, command: url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, command: url, error: msg };
  }
}

/**
 * Build a link and hand it to the OS. A builder error (e.g. an unparseable
 * reference) comes back as a failed result, the same as a launch failure.
 *
 * @param build - Builds the link; may throw.
 * @param options.restoreFocus - Passed to `openUrl`.
 * @returns Whether the link was sent.
 */
export async function launchLogosUrl(
  build: () => string,
  options: { restoreFocus?: boolean } = {}
): Promise<LogosCommandResult> {
  let url: string;
  try {
    url = build();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, command: "", error: msg };
  }
  return openUrl(url, options);
}

/**
 * Whether tasklist output (`/NH /FO CSV`) lists Logos.exe or Verbum.exe.
 *
 * @param stdout - tasklist output.
 * @returns True when either process is listed.
 */
export function tasklistHasLogos(stdout: string): boolean {
  return stdout.split(/\r?\n/).some((line) => {
    const name = line.match(/^"([^"]*)"/)?.[1]?.toLowerCase();
    return name === "logos.exe" || name === "verbum.exe";
  });
}

async function runTasklist(args: string[]): Promise<string> {
  return (await execFileAsync("tasklist", args)).stdout;
}

/**
 * Whether Logos (or Verbum) is running. Never throws.
 *
 * @param platform - Replaced in tests.
 * @param tasklist - Runs tasklist with these arguments and returns its stdout; replaced in tests.
 * @returns True when either process is running.
 */
export async function isLogosRunning(
  platform: NodeJS.Platform = process.platform,
  tasklist: (args: string[]) => Promise<string> = runTasklist
): Promise<boolean> {
  try {
    if (platform === "win32") {
      // One filtered call per name, side by side: tasklist ANDs repeated /FI
      // filters, and an unfiltered list took 11 s (0.5 s filtered, Task 19).
      const outputs = await Promise.all(
        ["Logos.exe", "Verbum.exe"].map((name) => tasklist(["/NH", "/FO", "CSV", "/FI", `IMAGENAME eq ${name}`]))
      );
      return outputs.some(tasklistHasLogos);
    }
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'tell application "System Events" to (name of processes) contains "Logos"',
    ]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}
