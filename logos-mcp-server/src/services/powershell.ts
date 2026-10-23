import { execFile } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { HELPER_CACHE_DIR } from "../config.js";

// Runs the small PowerShell helpers behind the Windows UI features. Scripts
// are rewritten on every use (tiny files) so a stale copy never outlives a
// server upgrade (robrawks#9).

export const POWERSHELL_UNAVAILABLE = "PowerShell is unavailable or blocked by policy.";

/**
 * First statements of every helper script (after its `param` block): UTF-8
 * pipes. The Claude desktop app's children otherwise get the system code page
 * (437/1252), which garbles Greek and dashes (withdrawn copy design §3.7, in
 * history at 16da723; probe P8).
 */
export const UTF8_SETUP =
  "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)\r\n" +
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)";

/**
 * Writes a helper script into the helper cache (with a UTF-8 BOM, which
 * Windows PowerShell 5.1 needs to read a script as UTF-8).
 *
 * @param name - File name, e.g. "logos-titles.ps1".
 * @param source - Script text.
 * @param dir - Directory; defaults to `HELPER_CACHE_DIR`.
 * @returns The script's path.
 * @throws When the file can't be written or isn't there afterwards (for
 *   example an MSIX redirect PowerShell can't see, probe P8).
 */
export function writeHelperScript(name: string, source: string, dir: string = HELPER_CACHE_DIR): string {
  const path = join(dir, name);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "\uFEFF" + source, "utf8");
  } catch {
    // Reported below with the path.
  }
  if (!existsSync(path)) {
    throw new Error(`the helper script could not be written where PowerShell can read it (${path})`);
  }
  return path;
}

/**
 * Arguments that run a script file the same way every time.
 *
 * @param scriptPath - The .ps1 path.
 * @param args - Script arguments, e.g. ["-Url", url].
 * @returns The powershell.exe argument list.
 */
export function powershellFileArgs(scriptPath: string, args: string[] = []): string[] {
  return ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args];
}

export interface PowerShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs powershell.exe and collects its output. A non-zero exit code is a
 * normal result; the caller decides what it means.
 *
 * @param args - powershell.exe arguments.
 * @param options.timeoutMs - Kill after this long; defaults to 30 s.
 * @returns Exit code, stdout and stderr.
 * @throws `POWERSHELL_UNAVAILABLE` (plus details) when PowerShell can't be
 *   started, or a timeout error.
 */
export function runPowerShell(args: string[], options: { timeoutMs?: number } = {}): Promise<PowerShellResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      args,
      { timeout: options.timeoutMs ?? 30_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        const e = error as NodeJS.ErrnoException & { code?: string | number; killed?: boolean };
        if (e.killed) {
          reject(new Error(`PowerShell did not finish within ${options.timeoutMs ?? 30_000} ms.`));
          return;
        }
        if (typeof e.code === "number") {
          resolve({ exitCode: e.code, stdout, stderr });
          return;
        }
        reject(new Error(`${POWERSHELL_UNAVAILABLE} ${stderr || e.message}`.trim()));
      }
    );
  });
}
