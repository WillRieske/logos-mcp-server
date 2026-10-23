import { spawn } from "child_process";
import type { Readable, Writable } from "stream";
import { DRIVER_LIMITS, type DriverLimits } from "../config.js";
import { POWERSHELL_UNAVAILABLE, UTF8_SETUP, powershellFileArgs, writeHelperScript } from "./powershell.js";
import { LOGOS_WINDOW_FINDER } from "./logos-window.js";
import {
  DriverError,
  type FocusedControl,
  type DriverErrorCode,
  type DriverInit,
  type LogosWindowInfo,
  type Point,
  type Rect,
  type UiDriver,
} from "./ui-driver.js";

// The Windows driver (withdrawn copy design §3.7, in history at 16da723): one
// PowerShell process per word study, started from a script in the helper
// cache. Node writes one JSON command per line on stdin; the script writes
// one JSON reply per line on stdout, plus {"event":"userInput"} lines from
// the consent-gated listener.

/** The parts of a child process the connection uses; faked in tests. */
export interface ChildLike {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  once(event: "close", listener: (code: number | null) => void): unknown;
  kill(): boolean;
}

interface Pending {
  cmd: string;
  /** Date.now() when the command was written. */
  sent: number;
  timeoutMs: number;
  /** Answers slower than this are logged. */
  slowMs: number;
  resolve: (reply: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function codeFor(error: string): DriverErrorCode {
  if (error === "foreground_changed") return "foreground_changed";
  if (error === "input_blocked") return "input_blocked";
  return "command";
}

/**
 * The line protocol. Replies are matched by id, so they may arrive in any
 * order; stdout chunks are buffered and only complete lines parsed. A command
 * that times out marks the driver failed: later requests are refused at once
 * and a reply that arrives late is dropped.
 */
export class DriverConnection {
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners: Array<(event: string) => void> = [];
  private state: "open" | "failed" | "exited" = "open";
  private stderrTail = "";
  private readonly exited: Promise<void>;

  constructor(
    private readonly child: ChildLike,
    private readonly options: { commandTimeoutMs: number; closeGraceMs: number; warn?: (message: string) => void }
  ) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2_000);
    });
    // Writing after the process died raises EPIPE; the exit handler reports it.
    child.stdin.on("error", () => {});
    this.exited = new Promise((resolve) => {
      // "close" fires after stdout and stderr have ended, so a final reply and
      // the stderr reason are not lost to an early "exit".
      child.once("close", () => {
        this.onExit();
        resolve();
      });
    });
  }

  /** Listens for unsolicited events ("userInput"). */
  onEvent(listener: (event: string) => void): void {
    this.listeners.push(listener);
  }

  /**
   * Sends one command and waits for its reply.
   *
   * @param cmd - Command name.
   * @param args - Command fields.
   * @param options - `timeoutMs` defaults to the connection's command timeout;
   *   an answer slower than `slowMs` (default half the timeout) is logged.
   * @returns The reply object.
   * @throws DriverError ("timeout", "exited", "failed", or the reply's error).
   */
  request<T = Record<string, unknown>>(
    cmd: string,
    args: Record<string, unknown> = {},
    options: { timeoutMs?: number; slowMs?: number } = {}
  ): Promise<T> {
    if (this.state === "exited") return Promise.reject(new DriverError("exited", this.exitMessage()));
    if (this.state === "failed") return Promise.reject(new DriverError("failed", "the input driver stopped responding"));
    const id = this.nextId++;
    const ms = options.timeoutMs ?? this.options.commandTimeoutMs;
    const slowMs = options.slowMs ?? ms / 2;
    const sent = Date.now();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (this.state === "open") this.state = "failed";
        this.options.warn?.(`logos-mcp: the input driver gave no answer to "${cmd}" within ${ms} ms; treating it as stopped`);
        reject(new DriverError("timeout", `"${cmd}" got no answer within ${ms} ms`));
      }, ms);
      this.pending.set(id, { cmd, sent, timeoutMs: ms, slowMs, resolve: (reply) => resolve(reply as T), reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
  }

  /** Closes stdin (the script then exits) and kills it after the grace period. */
  async close(): Promise<void> {
    this.child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<"grace">((resolve) => {
      timer = setTimeout(() => resolve("grace"), this.options.closeGraceMs);
    });
    const first = await Promise.race([this.exited.then(() => "exited" as const), grace]);
    clearTimeout(timer);
    if (first === "grace") this.child.kill();
  }

  /** Ends the process at once. */
  kill(): void {
    this.child.kill();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.options.warn?.(`logos-mcp: ignoring non-JSON output from the input driver: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      this.options.warn?.(`logos-mcp: ignoring unexpected output from the input driver: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof message.event === "string") {
      for (const listener of this.listeners) {
        try {
          listener(message.event);
        } catch (e) {
          this.options.warn?.(`logos-mcp: an input-driver event listener failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return;
    }
    const entry = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
    if (!entry) return; // a reply to a command that already timed out
    clearTimeout(entry.timer);
    this.pending.delete(message.id as number);
    // A slow answer is logged, so a later timeout can be traced to a command
    // that was drifting toward it.
    const took = Date.now() - entry.sent;
    if (took > entry.slowMs) {
      this.options.warn?.(`logos-mcp: the input driver took ${took} ms to answer "${entry.cmd}" (timeout ${entry.timeoutMs} ms)`);
    }
    if (message.ok === true) {
      entry.resolve(message);
    } else {
      const error = typeof message.error === "string" ? message.error : `"${entry.cmd}" failed`;
      entry.reject(new DriverError(codeFor(error), error));
    }
  }

  private onExit(): void {
    this.state = "exited";
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new DriverError("exited", this.exitMessage()));
      this.pending.delete(id);
    }
  }

  private exitMessage(): string {
    const last = this.stderrTail.trim().split(/\r?\n/).pop();
    return `the input driver stopped (process exited)${last ? `: ${last}` : ""}`;
  }
}

/** One TabControl as UI Automation reports it (W11, W23). */
export interface UiaPanel {
  tabs: Array<{ name: string; selected: boolean }>;
}

function toPanels(value: unknown): UiaPanel[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map((p) => {
    const raw = p as { tabs?: unknown };
    const tabs = Array.isArray(raw.tabs) ? raw.tabs : raw.tabs ? [raw.tabs] : [];
    return {
      tabs: tabs.map((t) => ({ name: String((t as { name?: unknown }).name ?? ""), selected: (t as { selected?: unknown }).selected === true })),
    };
  });
}

/** UiDriver over the PowerShell driver process. */
export class WindowsUiDriver implements UiDriver {
  private readonly limits: DriverLimits;

  constructor(
    private readonly connection: DriverConnection,
    options: { limits?: DriverLimits } = {}
  ) {
    this.limits = options.limits ?? DRIVER_LIMITS;
  }

  async init(): Promise<DriverInit> {
    // The first command also waits for PowerShell to start and compile its
    // helpers, and hands the script its pauses (DRIVER_LIMITS.driverTiming).
    const r = await this.connection.request<{ perMonitorAware?: boolean; busy?: boolean }>(
      "init",
      { timing: this.limits.driverTiming },
      { timeoutMs: this.limits.initTimeoutMs }
    );
    return { perMonitorAware: r.perMonitorAware === true, busy: r.busy === true };
  }

  async logosWindow(): Promise<LogosWindowInfo> {
    const r = await this.connection.request<Partial<LogosWindowInfo>>("logosWindow");
    if (r.found === true && (r.handle === undefined || r.handle === null || r.handle === "")) {
      throw new DriverError("command", "the input driver reported a Logos window without a handle");
    }
    if (r.found !== true) return { found: false, handle: "", minimized: false, client: { left: 0, top: 0, right: 0, bottom: 0 }, dpi: 96 };
    return {
      found: true,
      handle: String(r.handle),
      minimized: r.minimized === true,
      client: r.client as Rect,
      dpi: typeof r.dpi === "number" ? r.dpi : 96,
    };
  }

  async inputAvailable(): Promise<boolean> {
    return (await this.connection.request<{ available?: boolean }>("inputCheck")).available === true;
  }

  async typeText(text: string): Promise<void> {
    // Each unit takes typeStepMs plus up to ~30 ms of timer granularity; the default 5 s would cut long input short.
    const timeoutMs = this.limits.commandTimeoutMs + text.length * (this.limits.driverTiming.typeStepMs + 30);
    await this.connection.request("typeText", { text }, { timeoutMs });
  }

  async pressEnter(): Promise<void> {
    await this.connection.request("pressEnter");
  }

  async focusedControl(): Promise<FocusedControl> {
    const r = await this.connection.request<{ control?: unknown; inLogos?: unknown }>(
      "focusedControl",
      {},
      { timeoutMs: this.limits.uiaTimeoutMs }
    );
    if (typeof r.control !== "string" || typeof r.inLogos !== "boolean") {
      throw new DriverError("command", "the input driver returned no focus information");
    }
    return { control: r.control, inLogos: r.inLogos };
  }

  async foreground(): Promise<string> {
    return String((await this.connection.request<{ handle?: string }>("foreground")).handle ?? "");
  }

  async focus(handle: string): Promise<void> {
    await this.connection.request("focus", { handle });
  }

  async cursor(): Promise<Point> {
    const r = await this.connection.request<{ x?: number; y?: number }>("cursor");
    if (typeof r.x !== "number" || typeof r.y !== "number" || !Number.isFinite(r.x) || !Number.isFinite(r.y)) {
      throw new DriverError("command", "the input driver returned no cursor position");
    }
    return { x: r.x, y: r.y };
  }

  async tabs(): Promise<string[]> {
    const r = await this.connection.request<{ panels?: unknown }>("tabs", {}, { timeoutMs: this.limits.uiaTimeoutMs });
    return toPanels(r.panels).flatMap((p) => p.tabs.map((t) => t.name));
  }

  async startListener(): Promise<boolean> {
    return (await this.connection.request<{ started?: boolean }>("startListener")).started === true;
  }

  onUserInput(callback: () => void): void {
    this.connection.onEvent((event) => {
      if (event === "userInput") callback();
    });
  }

  close(): Promise<void> {
    return this.connection.close();
  }

  kill(): void {
    this.connection.kill();
  }
}

/**
 * The driver script (withdrawn copy design §3.7, in history at 16da723),
 * adapted from the 2026-10-17 probe scripts (drv.ps1, hook.cs, tabs.ps1,
 * takeover.ps1). Input is SendInput. Before every key event it checks that
 * Logos is the foreground window and stops the command with
 * "foreground_changed" if not; releases (key up) are always sent so nothing
 * stays held down. The INPUT union is at offset 8: powershell.exe is 64-bit.
 */
export const WINDOWS_DRIVER_SOURCE = String.raw`${UTF8_SETUP}
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class LogosMcpDriver {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  public struct POINT { public int X, Y; }
  public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; }
  static uint Send(INPUT input) { return SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))); }
  public static uint Mouse(uint flags, int data) { INPUT i = new INPUT(); i.type = 0; i.mi.dwFlags = flags; i.mi.mouseData = unchecked((uint)data); return Send(i); }
  public static uint Key(ushort vk, bool up) { INPUT i = new INPUT(); i.type = 1; i.ki.vk = vk; i.ki.flags = up ? 2u : 0u; return Send(i); }
  // KEYEVENTF_UNICODE (4): types the UTF-16 unit whatever the keyboard layout.
  public static uint UnicodeKey(ushort unit, bool up) { INPUT i = new INPUT(); i.type = 1; i.ki.scan = unit; i.ki.flags = up ? 6u : 4u; return Send(i); }

  static readonly object Gate = new object();
  public static void Line(string s) { lock (Gate) { Console.Out.Write(s + "\n"); Console.Out.Flush(); } }

  delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; }
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint threadId);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  static HookProc mouseProc;
  static HookProc keyProc;
  static int reported;
  // Only the injected flag is read: MSLLHOOKSTRUCT.flags is at offset 12,
  // KBDLLHOOKSTRUCT.flags at offset 8. Key codes and coordinates are never read.
  static IntPtr OnMouse(int code, IntPtr w, IntPtr l) { if (code >= 0 && (Marshal.ReadInt32(l, 12) & 1) == 0) Report(); return CallNextHookEx(IntPtr.Zero, code, w, l); }
  static IntPtr OnKey(int code, IntPtr w, IntPtr l) { if (code >= 0 && (Marshal.ReadInt32(l, 8) & 0x10) == 0) Report(); return CallNextHookEx(IntPtr.Zero, code, w, l); }
  static void Report() { if (Interlocked.Exchange(ref reported, 1) == 0) ThreadPool.QueueUserWorkItem(delegate { Line("{\"event\":\"userInput\"}"); }); }
  static bool listening;
  static bool abandoned;
  static readonly object gate = new object();
  // Once per driver process: a second call would replace the delegates the
  // first hooks still use, so it reports the running listener instead.
  // Waits up to 4 s (inside Node's 5 s command timeout). If the hooks take
  // longer, the attempt is abandoned under the lock, and the hook thread
  // removes any hooks it installs afterwards, so the reply ("started")
  // always matches what is live.
  public static bool StartListener() {
    if (listening) return true;
    bool ok = false;
    ManualResetEvent ready = new ManualResetEvent(false);
    Thread thread = new Thread(delegate () {
      mouseProc = OnMouse;
      keyProc = OnKey;
      IntPtr module = GetModuleHandle(null);
      IntPtr mouse = SetWindowsHookEx(14, mouseProc, module, 0);
      IntPtr key = SetWindowsHookEx(13, keyProc, module, 0);
      bool live;
      lock (gate) {
        live = mouse != IntPtr.Zero && key != IntPtr.Zero && !abandoned;
        ok = live;
        ready.Set();
      }
      if (live) { MSG msg; while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { } }
      // Reached when a hook failed or the attempt was abandoned, or if the loop
      // ends (a WM_QUIT nobody sends today); normally the hooks go when the
      // driver process exits.
      if (mouse != IntPtr.Zero) UnhookWindowsHookEx(mouse);
      if (key != IntPtr.Zero) UnhookWindowsHookEx(key);
    });
    thread.IsBackground = true;
    thread.Start();
    bool signalled = ready.WaitOne(4000);
    lock (gate) {
      if (!signalled && !ready.WaitOne(0)) abandoned = true;
      listening = ok && !abandoned;
    }
    return listening;
  }
}
'@
${LOGOS_WINDOW_FINDER}

# Native window handles from a UIA element up to the first real one (WPF
# content elements report 0), at most 64 steps.
function Get-FocusHandles($el) {
  $walker = [Windows.Automation.TreeWalker]::RawViewWalker
  $handles = @()
  $n = $el
  for ($i = 0; ($n -ne $null) -and ($i -lt 64); $i++) {
    $h = [long]$n.Current.NativeWindowHandle
    $handles += $h
    if ($h -ne 0) { break }
    $n = $walker.GetParent($n)
  }
  return $handles
}
# >>> focus window check (run by tests/ui-driver-windows.test.ts with made-up handles)
# Is the focused control inside the window $main? The first non-zero handle is
# the control's own window; its root by parent (GA_ROOT, not by owner) must be
# $main. A hover popup is a top-level window of its own, so focus inside it
# fails even though it belongs to the Logos process (I16).
function Test-FocusInWindow($handles, [IntPtr]$main, [scriptblock]$rootOf) {
  if ($main -eq [IntPtr]::Zero) { return $false }
  foreach ($h in $handles) {
    if ([long]$h -ne 0) { return ((& $rootOf ([IntPtr][long]$h)) -eq $main) }
  }
  return $false
}
# <<< focus window check

# Once per process: the call fails (ERROR_ACCESS_DENIED) when awareness is already set.
$script:PerMonitorAware = [LogosMcpDriver]::SetProcessDpiAwarenessContext([IntPtr](-4))
if (-not $script:PerMonitorAware) { $script:PerMonitorAware = ([LogosMcpDriver]::GetAwarenessFromDpiAwarenessContext([LogosMcpDriver]::GetThreadDpiAwarenessContext()) -eq 2) }

# One input operation at a time across server processes.
$script:Mutex = New-Object System.Threading.Mutex($false, "Local\logos-mcp-ui-driver")
$script:OwnsMutex = $false
try { $script:OwnsMutex = $script:Mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $script:OwnsMutex = $true }

$script:H = [IntPtr]::Zero
$script:LogosPid = $null

function Reply($id, $fields) {
  $o = [ordered]@{ id = $id; ok = $true }
  foreach ($k in $fields.Keys) { $o[$k] = $fields[$k] }
  [LogosMcpDriver]::Line(($o | ConvertTo-Json -Compress -Depth 6))
}
function Fail($id, $message) {
  [LogosMcpDriver]::Line(([ordered]@{ id = $id; ok = $false; error = [string]$message } | ConvertTo-Json -Compress))
}
function Guard {
  if ($script:H -eq [IntPtr]::Zero) { throw "logos_window_unknown" }
  if ([LogosMcpDriver]::GetForegroundWindow() -ne $script:H) { throw "foreground_changed" }
}
function Sent($count) { if ($count -lt 1) { throw "input_blocked" } }
function RootElement {
  if ($script:H -eq [IntPtr]::Zero) { throw "logos_window_unknown" }
  return [Windows.Automation.AutomationElement]::FromHandle($script:H)
}
function ByClass($name) { return New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ClassNameProperty, $name) }
# The per-pass tab check needs only the tab names, so this reads no DisplayPane.
function Panels {
  $root = RootElement
  $result = @()
  foreach ($tc in $root.FindAll([Windows.Automation.TreeScope]::Descendants, (ByClass "TabControl"))) {
    $tabs = @()
    foreach ($ti in $tc.FindAll([Windows.Automation.TreeScope]::Children, (ByClass "TabItem"))) {
      $selected = $false
      try { $selected = $ti.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected } catch {}
      $tabs += @{ name = $ti.Current.Name; selected = [bool]$selected }
    }
    $result += @{ tabs = $tabs }
  }
  return ,$result
}

try {
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($line -eq $null) { break }
    if ($line.Trim().Length -eq 0) { continue }
    $id = $null
    try {
      $req = ConvertFrom-Json $line
      $id = $req.id
      # Every pause comes from init's timing (DRIVER_LIMITS.driverTiming), so no
      # other command may run before it.
      if ($req.cmd -ne "init" -and $script:T -eq $null) { throw "driver_not_initialised" }
      switch ($req.cmd) {
        "init" {
          if ($req.timing -eq $null) { throw "init needs timing" }
          foreach ($k in @("keyStepMs", "enterReleaseMs", "typeStepMs", "focusSettleMs")) {
            $v = $req.timing.$k
            if (-not (($v -is [int]) -or ($v -is [long]) -or ($v -is [double])) -or $v -lt 0) { throw ("init timing needs a non-negative number: " + $k) }
          }
          $script:T = $req.timing
          Reply $id @{ perMonitorAware = [bool]$script:PerMonitorAware; busy = (-not $script:OwnsMutex) }
        }
        "logosWindow" {
          $w = Find-LogosMainWindow
          if ($w -eq $null) { Reply $id @{ found = $false } }
          else {
            $script:H = $w.Handle
            $script:LogosPid = $w.ProcessId
            $rc = New-Object LogosMcpDriver+RECT
            [void][LogosMcpDriver]::GetClientRect($script:H, [ref]$rc)
            $origin = New-Object LogosMcpDriver+POINT
            [void][LogosMcpDriver]::ClientToScreen($script:H, [ref]$origin)
            Reply $id @{
              found = $true
              handle = [string]$script:H.ToInt64()
              minimized = [bool][LogosMcpDriver]::IsIconic($script:H)
              dpi = [int][LogosMcpDriver]::GetDpiForWindow($script:H)
              client = @{ left = $origin.X; top = $origin.Y; right = $origin.X + $rc.Right; bottom = $origin.Y + $rc.Bottom }
            }
          }
        }
        "inputCheck" {
          # Exempt from Guard on purpose: a zero-distance relative move changes
          # nothing on screen and reaches no window, and it runs before the Logos
          # window is known. It only proves SendInput is not blocked.
          $fg = [LogosMcpDriver]::GetForegroundWindow()
          $n = [LogosMcpDriver]::Mouse(1, 0)
          Reply $id @{ available = (($fg -ne [IntPtr]::Zero) -and ($n -eq 1)) }
        }
        "typeText" {
          # One UTF-16 unit at a time, Logos checked before each; the release is always sent.
          foreach ($unit in ([string]$req.text).ToCharArray()) {
            Guard; Sent ([LogosMcpDriver]::UnicodeKey([uint16]$unit, $false))
            try { Start-Sleep -Milliseconds $script:T.typeStepMs } finally { [void][LogosMcpDriver]::UnicodeKey([uint16]$unit, $true) }
          }
          Reply $id @{}
        }
        "pressEnter" {
          Guard; Sent ([LogosMcpDriver]::Key(0x0D, $false))
          try { Start-Sleep -Milliseconds $script:T.keyStepMs } finally { [void][LogosMcpDriver]::Key(0x0D, $true) }
          Start-Sleep -Milliseconds $script:T.enterReleaseMs
          Reply $id @{}
        }
        "focusedControl" {
          # Read-only: which control has keyboard focus, and is it inside the Logos main window.
          $el = [Windows.Automation.AutomationElement]::FocusedElement
          $name = ""
          $mine = $false
          if ($el -ne $null) {
            $name = ([string]$el.Current.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
            $mine = ($script:LogosPid -ne $null) -and ([uint32]$el.Current.ProcessId -eq $script:LogosPid) -and
              (Test-FocusInWindow (Get-FocusHandles $el) $script:H { param($h) [LogosMcpDriver]::GetAncestor($h, 2) })
          }
          Reply $id @{ control = $name; inLogos = $mine }
        }
        "foreground" {
          Reply $id @{ handle = [string][LogosMcpDriver]::GetForegroundWindow().ToInt64() }
        }
        "focus" {
          $target = [IntPtr][long]$req.handle
          # Already in front: nothing to do, and no Alt tap to disturb the window.
          if ([LogosMcpDriver]::GetForegroundWindow() -ne $target) {
            [void][LogosMcpDriver]::Key(0x12, $false)
            try { [void][LogosMcpDriver]::SetForegroundWindow($target) } finally { [void][LogosMcpDriver]::Key(0x12, $true) }
            Start-Sleep -Milliseconds $script:T.focusSettleMs
          }
          Reply $id @{}
        }
        "cursor" {
          $pt = New-Object LogosMcpDriver+POINT
          [void][LogosMcpDriver]::GetCursorPos([ref]$pt)
          Reply $id @{ x = $pt.X; y = $pt.Y }
        }
        "tabs" {
          $list = Panels
          Reply $id @{ panels = $list }
        }
        "startListener" {
          Reply $id @{ started = [LogosMcpDriver]::StartListener() }
        }
        default { throw ("unknown command: " + $req.cmd) }
      }
    } catch {
      Fail $id $_.Exception.Message
    }
  }
} finally {
  if ($script:OwnsMutex) { try { $script:Mutex.ReleaseMutex() } catch {} }
}
`;

/**
 * Starts the PowerShell driver for one word study.
 *
 * @returns A connected driver.
 * @throws When the script can't be written or PowerShell can't start.
 */
export async function createWindowsDriver(): Promise<UiDriver> {
  const script = writeHelperScript("logos-ui-driver.ps1", WINDOWS_DRIVER_SOURCE);
  const child = spawn("powershell.exe", powershellFileArgs(script), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const failure = await new Promise<Error | null>((resolve) => {
    child.once("spawn", () => resolve(null));
    child.once("error", (e) => resolve(e));
  });
  if (failure) throw new Error(`${POWERSHELL_UNAVAILABLE} ${failure.message}`);
  const warn = (message: string): void => console.error(message);
  // A later 'error' event (e.g. a failed kill) must neither throw nor vanish.
  child.on("error", (e) => warn(`logos-mcp: the input driver process reported an error: ${e.message}`));
  const connection = new DriverConnection(child, {
    commandTimeoutMs: DRIVER_LIMITS.commandTimeoutMs,
    closeGraceMs: DRIVER_LIMITS.closeGraceMs,
    warn,
  });
  return new WindowsUiDriver(connection);
}
