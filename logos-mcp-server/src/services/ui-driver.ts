// The platform piece open_word_study drives: keyboard input and window state.
// word-study.ts talks only to this interface; the Windows driver implements it.

/** A screen point in physical pixels. */
export interface Point {
  x: number;
  y: number;
}

/** A screen rectangle in physical pixels. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** What the driver reports when it starts. */
export interface DriverInit {
  /** Per-monitor DPI aware, so coordinates are physical pixels. */
  perMonitorAware: boolean;
  /** Another server process's input operation holds the driver mutex. */
  busy: boolean;
}

/** The Logos main window as the driver sees it. */
export interface LogosWindowInfo {
  found: boolean;
  /** Opaque window handle; compared with `foreground()`. */
  handle: string;
  minimized: boolean;
  /** Client area in screen coordinates. */
  client: Rect;
  dpi: number;
}

/** The keyboard focus as the driver sees it. */
export interface FocusedControl {
  /** UI Automation control type without the prefix, e.g. "Edit"; "" when nothing has focus. */
  control: string;
  /** The focused element belongs to the Logos process. */
  inLogos: boolean;
}

/**
 * timeout/exited/failed: the driver is gone or stopped answering.
 * command: one command failed. foreground_changed: Logos was not in front
 * when input was about to be sent (a takeover). input_blocked: Windows
 * refused synthetic input.
 */
export type DriverErrorCode = "timeout" | "exited" | "failed" | "command" | "foreground_changed" | "input_blocked";

/** A driver failure, with a code word study uses to decide how to stop. */
export class DriverError extends Error {
  constructor(readonly code: DriverErrorCode, message: string) {
    super(message);
    this.name = "DriverError";
  }
}

/** One driver serves one word study: create, use, close. */
export interface UiDriver {
  init(): Promise<DriverInit>;
  logosWindow(): Promise<LogosWindowInfo>;
  /** Whether synthetic input can reach the desktop (not locked, not blocked). */
  inputAvailable(): Promise<boolean>;
  /** Types text as Unicode key events (no layout, no clipboard); stops with foreground_changed if Logos loses the front. */
  typeText(text: string): Promise<void>;
  /** Presses Enter, with the same Logos-in-front check as `typeText`. */
  pressEnter(): Promise<void>;
  /** What has keyboard focus. */
  focusedControl(): Promise<FocusedControl>;
  foreground(): Promise<string>;
  focus(handle: string): Promise<void>;
  cursor(): Promise<Point>;
  tabs(): Promise<string[]>;
  /** Starts the consent-gated input listener; false when it couldn't start. */
  startListener(): Promise<boolean>;
  onUserInput(callback: () => void): void;
  /** Ends the driver: input stops, hooks are removed. */
  close(): Promise<void>;
  /** Ends the driver at once (the UI lock timed out). */
  kill(): void;
}

/**
 * Starts the driver. Only Windows has one: word-study typing is Windows-only.
 *
 * @param platform - Defaults to the running platform.
 * @returns A started driver.
 * @throws On platforms other than Windows, or when the driver can't start.
 */
export async function createUiDriver(platform: NodeJS.Platform = process.platform): Promise<UiDriver> {
  if (platform === "win32") {
    const { createWindowsDriver } = await import("./ui-driver-windows.js");
    return createWindowsDriver();
  }
  throw new Error("Typing into Logos is supported on Windows only.");
}

const DRIVER_REASON = "the input driver stopped responding";
const INPUT_BLOCKED_REASON = "Windows is blocking input: the PC may be locked, or Logos may be running as administrator.";

/**
 * The stop reason for a driver failure; "command" errors carry the driver's
 * own message, and a timeout names the command that got no answer.
 *
 * @param e - The driver failure.
 * @returns A reason for the tool's reply.
 */
export function driverReason(e: DriverError): string {
  if (e.code === "input_blocked") return INPUT_BLOCKED_REASON;
  if (e.code === "command") return `the input driver reported an error: ${e.message}`;
  if (e.code === "timeout") return `${DRIVER_REASON} (${e.message})`;
  return DRIVER_REASON;
}
