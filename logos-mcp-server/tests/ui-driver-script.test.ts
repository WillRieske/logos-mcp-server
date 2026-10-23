// tests/ui-driver-script.test.ts
// Runs the real driver script (Windows PowerShell 5.1) without Logos: the
// removed clipboard, mouse and panel commands must be unknown to it.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DriverConnection, WINDOWS_DRIVER_SOURCE } from "../src/services/ui-driver-windows.js";
import { powershellFileArgs, writeHelperScript } from "../src/services/powershell.js";
import { DRIVER_LIMITS } from "../src/config.js";
import { REMOVED_DRIVER_COMMANDS } from "./helpers/removed-driver-commands.js";

const onWindows = process.platform === "win32";
// Its own temp folder: writeHelperScript defaults to the real helper cache.
const dir = onWindows ? mkdtempSync(join(tmpdir(), "logos-mcp-driver-")) : "";
const connections: DriverConnection[] = [];

function startScript(): DriverConnection {
  const script = writeHelperScript("logos-ui-driver.ps1", WINDOWS_DRIVER_SOURCE, dir);
  const child = spawn("powershell.exe", powershellFileArgs(script), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const c = new DriverConnection(child, { commandTimeoutMs: 15_000, closeGraceMs: DRIVER_LIMITS.closeGraceMs });
  connections.push(c);
  return c;
}

describe.runIf(onWindows)("driver script (real PowerShell, no Logos)", () => {
  afterAll(async () => {
    for (const c of connections) await c.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers the removed commands with unknown command", async () => {
    const c = startScript();
    await c.request("init", { timing: DRIVER_LIMITS.driverTiming }, { timeoutMs: DRIVER_LIMITS.initTimeoutMs });
    for (const cmd of REMOVED_DRIVER_COMMANDS) {
      await expect(c.request(cmd), cmd).rejects.toMatchObject({ code: "command", message: `unknown command: ${cmd}` });
    }
  }, 60_000);

  it("rejects an init that sends the old click timing instead of enterReleaseMs", async () => {
    const c = startScript();
    const old = { keyStepMs: 40, clickReleaseMs: 150, typeStepMs: 30, focusSettleMs: 200 };
    await expect(c.request("init", { timing: old }, { timeoutMs: DRIVER_LIMITS.initTimeoutMs })).rejects.toMatchObject({
      code: "command",
      message: "init timing needs a non-negative number: enterReleaseMs",
    });
  }, 30_000);
});
