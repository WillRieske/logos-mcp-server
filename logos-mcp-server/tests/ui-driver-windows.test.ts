import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import {
  DriverConnection,
  WindowsUiDriver,
  WINDOWS_DRIVER_SOURCE,
  type ChildLike,
  type UiaPanel,
} from "../src/services/ui-driver-windows.js";
import { DRIVER_LIMITS } from "../src/config.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { powershellFileArgs, runPowerShell, writeHelperScript } from "../src/services/powershell.js";

// Answers each command from a table; records the commands.
class ScriptedChild extends EventEmitter implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  commands: Array<Record<string, unknown>> = [];
  // An answer of null sends no reply (a command that hangs).
  constructor(private readonly answer: (req: Record<string, unknown>, nth: number) => Record<string, unknown> | null) {
    super();
    this.stdin.setEncoding("utf8");
    let buffer = "";
    this.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const req = JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>;
        buffer = buffer.slice(nl + 1);
        this.commands.push(req);
        const nth = this.commands.filter((c) => c.cmd === req.cmd).length;
        const reply = this.answer(req, nth);
        if (reply) this.stdout.write(`${JSON.stringify({ id: req.id, ok: true, ...reply })}\n`);
      }
    });
    this.stdin.on("end", () => this.emit("close", 0));
  }
  kill(): boolean {
    this.emit("close", 1);
    return true;
  }
}

// W23 (LEB and Phillips as tabs in one panel).
const LEB_PHILLIPS = (selected: "leb" | "phillips"): UiaPanel => ({
  tabs: [
    { name: "The Lexham English Bible", selected: selected === "leb" },
    { name: "John, Volumes 1 & 2", selected: selected === "phillips" },
  ],
});

function driverFor(answer: (req: Record<string, unknown>, nth: number) => Record<string, unknown> | null) {
  const child = new ScriptedChild(answer);
  const conn = new DriverConnection(child, { commandTimeoutMs: 5_000, closeGraceMs: 1_000 });
  const driver = new WindowsUiDriver(conn);
  return { child, driver };
}

describe("WindowsUiDriver", () => {
  it("sends typed text and Enter, and maps what has focus", async () => {
    const { child, driver } = driverFor((req) => (req.cmd === "focusedControl" ? { control: "Edit", inLogos: true } : {}));
    await driver.typeText("ἀγάπη");
    await driver.pressEnter();
    expect(await driver.focusedControl()).toEqual({ control: "Edit", inLogos: true });
    expect(child.commands.map(({ id, ...rest }) => rest)).toEqual([
      { cmd: "typeText", text: "ἀγάπη" },
      { cmd: "pressEnter" },
      { cmd: "focusedControl" },
    ]);
  });

  it("gives typed text a timeout that grows with its length", async () => {
    const { driver } = driverFor(() => ({}));
    const spy = vi.spyOn((driver as unknown as { connection: { request: (...a: unknown[]) => Promise<unknown> } }).connection, "request");
    await driver.typeText("x".repeat(100));
    const t = DRIVER_LIMITS.driverTiming.typeStepMs + 30;
    expect(spy).toHaveBeenCalledWith("typeText", { text: "x".repeat(100) }, { timeoutMs: DRIVER_LIMITS.commandTimeoutMs + 100 * t });
  });

  it("rejects a malformed focus reply", async () => {
    const { driver } = driverFor(() => ({ control: 3 }));
    await expect(driver.focusedControl()).rejects.toMatchObject({ code: "command" });
  });

  it("hands the driver script its pauses with init", async () => {
    const { child, driver } = driverFor(() => ({ perMonitorAware: true, busy: false }));
    await driver.init();
    expect(child.commands[0]).toMatchObject({ cmd: "init", timing: DRIVER_LIMITS.driverTiming });
  });

  it("maps window, input, foreground and cursor replies", async () => {
    const { driver } = driverFor((req) => {
      switch (req.cmd) {
        case "init": return { perMonitorAware: true, busy: false };
        case "logosWindow": return { found: true, handle: "123", minimized: false, dpi: 192, client: { left: 0, top: 0, right: 3072, bottom: 1834 } };
        case "inputCheck": return { available: true };
        case "foreground": return { handle: "123" };
        case "cursor": return { x: 5, y: 6 };
        case "startListener": return { started: true };
        default: return {};
      }
    });
    expect(await driver.init()).toEqual({ perMonitorAware: true, busy: false });
    expect(await driver.logosWindow()).toEqual({ found: true, handle: "123", minimized: false, dpi: 192, client: { left: 0, top: 0, right: 3072, bottom: 1834 } });
    expect(await driver.inputAvailable()).toBe(true);
    expect(await driver.foreground()).toBe("123");
    expect(await driver.cursor()).toEqual({ x: 5, y: 6 });
    expect(await driver.startListener()).toBe(true);
  });

  it("reports a missing Logos window", async () => {
    const { driver } = driverFor(() => ({ found: false }));
    expect((await driver.logosWindow()).found).toBe(false);
  });

  it("lists every tab name with the tabs command", async () => {
    const { child, driver } = driverFor((req) => (req.cmd === "tabs" ? { panels: [LEB_PHILLIPS("leb")] } : null));
    expect(await driver.tabs()).toEqual(["The Lexham English Bible", "John, Volumes 1 & 2"]);
    expect(child.commands.map((c) => c.cmd)).toEqual(["tabs"]);
  });

  it("passes the user-input event to its listener", async () => {
    const { child, driver } = driverFor(() => ({}));
    const seen: string[] = [];
    driver.onUserInput(() => seen.push("input"));
    child.stdout.write('{"event":"userInput"}\n');
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual(["input"]);
  });

  it("rejects malformed replies instead of inventing values", async () => {
    const bad = (answer: Record<string, unknown>) => driverFor(() => answer).driver;
    await expect(bad({ found: true }).logosWindow()).rejects.toMatchObject({ code: "command" });
    await expect(bad({ x: "a", y: 2 }).cursor()).rejects.toMatchObject({ code: "command" });
    await expect(bad({}).cursor()).rejects.toMatchObject({ code: "command" });
  });

  // UI Automation queries run on Logos's UI thread and walk its whole window
  // (measured 2026-10-18: 0.5-2.4 s idle, about 620 elements), so 5 s is too tight.
  it("gives the UI Automation query (tabs) the longer UIA timeout", async () => {
    vi.useFakeTimers();
    try {
      const { driver } = driverFor((req) => (req.cmd === "tabs" ? null : {}));
      let settled = false;
      const tabs = driver.tabs().catch((e: unknown) => e).finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(DRIVER_LIMITS.commandTimeoutMs);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(DRIVER_LIMITS.uiaTimeoutMs - DRIVER_LIMITS.commandTimeoutMs);
      expect(await tabs).toMatchObject({ code: "timeout", message: `"tabs" got no answer within ${DRIVER_LIMITS.uiaTimeoutMs} ms` });
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows UI Automation about six times the longest walk measured idle (2.4 s), inside word study's time limit", () => {
    expect(DRIVER_LIMITS.uiaTimeoutMs).toBe(15_000);
  });

  it("uses the configured init timeout", () => {
    expect(DRIVER_LIMITS.initTimeoutMs).toBe(15_000);
  });
});

describe("WINDOWS_DRIVER_SOURCE", () => {
  it("answers every command the Node side sends", () => {
    for (const cmd of ["init", "logosWindow", "inputCheck", "foreground", "focus", "cursor", "tabs", "startListener", "typeText", "pressEnter", "focusedControl"]) {
      expect(WINDOWS_DRIVER_SOURCE).toContain(`"${cmd}" {`);
    }
  });

  it("sets up UTF-8 pipes, per-monitor DPI awareness once, and the input mutex", () => {
    expect(WINDOWS_DRIVER_SOURCE.startsWith("[Console]::InputEncoding")).toBe(true);
    expect(WINDOWS_DRIVER_SOURCE).toContain("SetProcessDpiAwarenessContext([IntPtr](-4))");
    expect(WINDOWS_DRIVER_SOURCE).toContain('"Local\\logos-mcp-ui-driver"');
    expect(WINDOWS_DRIVER_SOURCE).toContain("AbandonedMutexException");
  });

  it("checks the foreground before input and reads only the injected flag in its hooks", () => {
    expect(WINDOWS_DRIVER_SOURCE).toContain('throw "foreground_changed"');
    expect(WINDOWS_DRIVER_SOURCE).toContain("Marshal.ReadInt32(l, 12) & 1");
    expect(WINDOWS_DRIVER_SOURCE).toContain("Marshal.ReadInt32(l, 8) & 0x10");
  });

  it("reports the listener as started only when its hooks are live, abandoning a slow start", () => {
    expect(WINDOWS_DRIVER_SOURCE).toContain("ready.WaitOne(4000)");
    expect(WINDOWS_DRIVER_SOURCE).toContain("abandoned = true");
    expect(WINDOWS_DRIVER_SOURCE).toContain("live = mouse != IntPtr.Zero && key != IntPtr.Zero && !abandoned;");
    expect(WINDOWS_DRIVER_SOURCE).toContain("listening = ok && !abandoned;");
  });

  it("types one guarded Unicode unit at a time and always releases it, and never reads the clipboard to type", () => {
    const block = WINDOWS_DRIVER_SOURCE.slice(
      WINDOWS_DRIVER_SOURCE.indexOf('"typeText" {'),
      WINDOWS_DRIVER_SOURCE.indexOf('"focusedControl" {')
    );
    expect(block).toContain("Guard; Sent ([LogosMcpDriver]::UnicodeKey([uint16]$unit, $false))");
    expect(block).toContain("finally { [void][LogosMcpDriver]::UnicodeKey([uint16]$unit, $true) }");
    expect(block).toContain("Guard; Sent ([LogosMcpDriver]::Key(0x0D, $false))");
    expect(block).toContain("finally { [void][LogosMcpDriver]::Key(0x0D, $true) }");
    expect(block).not.toMatch(/Clipboard/);
    expect(WINDOWS_DRIVER_SOURCE).toContain("i.ki.flags = up ? 6u : 4u");
  });

  it("contains no backtick, which would end the TypeScript template", () => {
    expect(WINDOWS_DRIVER_SOURCE.includes(String.fromCharCode(96))).toBe(false);
  });

  it("takes every pause from init's timing, not from literals", () => {
    expect(WINDOWS_DRIVER_SOURCE).toContain("$script:T = $req.timing");
    expect(WINDOWS_DRIVER_SOURCE).toContain('throw "driver_not_initialised"');
    expect(WINDOWS_DRIVER_SOURCE).not.toMatch(/Start-Sleep -Milliseconds \d/);
    for (const key of Object.keys(DRIVER_LIMITS.driverTiming)) {
      expect(WINDOWS_DRIVER_SOURCE).toContain(`$script:T.${key}`);
    }
  });

  it("validates every timing key at init", () => {
    for (const key of Object.keys(DRIVER_LIMITS.driverTiming)) {
      expect(WINDOWS_DRIVER_SOURCE).toContain(`"${key}"`);
    }
    expect(WINDOWS_DRIVER_SOURCE).toContain("init timing needs a non-negative number");
    expect(WINDOWS_DRIVER_SOURCE).toContain("if ([LogosMcpDriver]::GetForegroundWindow() -ne $target)");
  });
});

// The driver script's focus check (the marked block), run under Windows
// PowerShell with made-up handles and a fake GA_ROOT lookup: no real window.
// I16: a Logos hover popup belongs to the Logos process but is a top-level
// window of its own, so focus inside it must not count as inside Logos.
describe.runIf(process.platform === "win32")("focus window check (Windows PowerShell)", () => {
  const START = "# >>> focus window check";
  const END = "# <<< focus window check";
  // Main window 100 holds child window 101; popup 200 holds child 201.
  const SCENARIOS: Record<string, string> = {
    mainChild: "@(0, 0, 101)",
    mainItself: "@(100)",
    popupChild: "@(0, 201)",
    popupItself: "@(200)",
    noWindow: "@(0, 0)",
    empty: "@()",
  };

  it("counts focus as inside only when the control's root window is the main window", async () => {
    const start = WINDOWS_DRIVER_SOURCE.indexOf(START);
    const end = WINDOWS_DRIVER_SOURCE.indexOf(END);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = WINDOWS_DRIVER_SOURCE.slice(start, end);
    const runs = Object.entries(SCENARIOS).map(
      ([name, handles]) => `$results['${name}'] = [bool](Test-FocusInWindow ${handles} ([IntPtr]100) $rootOf)`
    );
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$block = @'\n${block}\n'@`,
      ". ([scriptblock]::Create($block))",
      "$roots = @{ 100 = 100; 101 = 100; 200 = 200; 201 = 200 }",
      "$rootOf = { param($h) [IntPtr][long]$roots[[int]$h.ToInt64()] }",
      "$results = [ordered]@{}",
      ...runs,
      "$results['noMainWindow'] = [bool](Test-FocusInWindow @(101) ([IntPtr]::Zero) $rootOf)",
      "[Console]::Out.Write(($results | ConvertTo-Json -Compress))",
    ].join("\r\n");
    const dir = mkdtempSync(join(tmpdir(), "logos-mcp-focuswin-"));
    try {
      const path = writeHelperScript("focus-window-check.ps1", script, dir);
      const result = await runPowerShell(powershellFileArgs(path), { timeoutMs: 30_000 });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        mainChild: true,
        mainItself: true,
        popupChild: false,
        popupItself: false,
        noWindow: false,
        empty: false,
        noMainWindow: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("is what the focusedControl command uses, with GA_ROOT and the process check", () => {
    const block = WINDOWS_DRIVER_SOURCE.slice(
      WINDOWS_DRIVER_SOURCE.indexOf('"focusedControl" {'),
      WINDOWS_DRIVER_SOURCE.indexOf('"foreground" {')
    );
    expect(block).toContain("[uint32]$el.Current.ProcessId -eq $script:LogosPid");
    expect(block).toContain("Test-FocusInWindow (Get-FocusHandles $el) $script:H { param($h) [LogosMcpDriver]::GetAncestor($h, 2) }");
  });
});

