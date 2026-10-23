import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  UTF8_SETUP,
  writeHelperScript,
  powershellFileArgs,
  runPowerShell,
} from "../src/services/powershell.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "logos-mcp-ps-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("writeHelperScript", () => {
  it("writes the script with a UTF-8 BOM and returns its path", () => {
    const dir = tempDir();
    const path = writeHelperScript("x.ps1", "Write-Output 'ok'", join(dir, "cache"));
    expect(path).toBe(join(dir, "cache", "x.ps1"));
    const bytes = readFileSync(path);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString("utf8")).toBe("Write-Output 'ok'");
  });

  it("names the path when the script can't be written", () => {
    const dir = tempDir();
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "");
    expect(() => writeHelperScript("x.ps1", "", blocker)).toThrow(
      `the helper script could not be written where PowerShell can read it (${join(blocker, "x.ps1")})`
    );
  });
});

describe("powershellFileArgs", () => {
  it("runs a script file non-interactively, STA, without profile or policy prompts", () => {
    expect(powershellFileArgs("C:\\c\\x.ps1", ["-Url", "logosres:a"])).toEqual([
      "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", "C:\\c\\x.ps1", "-Url", "logosres:a",
    ]);
  });
});

describe.runIf(process.platform === "win32")("runPowerShell (Windows)", () => {
  it("round-trips Greek and dashes through the pipes (probe P8)", async () => {
    const dir = tempDir();
    const path = writeHelperScript("echo.ps1", String.raw`param([string]$T)
${UTF8_SETUP}
[Console]::Out.WriteLine("got:" + $T + ":" + [char]0x03BA)
exit 3`, dir);
    const result = await runPowerShell(powershellFileArgs(path, ["-T", "probatikē – x"]));
    expect(result.exitCode).toBe(3);
    expect(result.stdout.trim()).toBe("got:probatikē – x:κ");
  });
});
