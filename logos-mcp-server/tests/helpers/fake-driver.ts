import {
  DriverError,
  type DriverInit,
  type FocusedControl,
  type LogosWindowInfo,
  type Point,
  type UiDriver,
} from "../../src/services/ui-driver.js";

/** Commands that send input (for "no input after a takeover" checks). */
export const INPUT_COMMANDS = ["typeText", "pressEnter", "focus"];

/**
 * A scripted UiDriver. Logos is window "100"; the user's window is "555".
 * Input commands move `cursorPos` to where the real driver leaves the cursor.
 */
export class FakeDriver implements UiDriver {
  log: string[] = [];
  initResult: DriverInit = { perMonitorAware: true, busy: false };
  window: LogosWindowInfo = {
    found: true,
    handle: "100",
    minimized: false,
    client: { left: 0, top: 0, right: 3072, bottom: 1834 },
    dpi: 192,
  };
  inputOk = true;
  /** The user is in their own window until the open brings Logos forward. */
  foregroundHandle = "555";
  cursorPos: Point = { x: 40, y: 40 };
  /** What has keyboard focus: the word box once Logos has opened a study. */
  focused: FocusedControl = { control: "Edit", inLogos: true };
  tabList: string[] = ["The Gospel according to John"];
  listenerStarts = true;
  /** Runs after a call is logged and before it returns; gets the call count. */
  on: Partial<Record<string, (count: number) => void | Promise<void>>> = {};
  /** The next call of each named method never settles. */
  hang = new Set<string>();
  /** Calls of each named method throw this. */
  failWith = new Map<string, DriverError>();
  focusWorks = true;
  closed = false;
  killed = false;
  private counts = new Map<string, number>();
  private userInput: (() => void) | null = null;

  /** Simulates the listener's {"event":"userInput"}. */
  emitUserInput(): void {
    this.userInput?.();
  }

  /** Every later call fails as if the process had exited. */
  crash(): void {
    for (const name of [
      "logosWindow", "inputAvailable", "typeText", "pressEnter", "focusedControl",
      "foreground", "focus", "cursor", "tabs", "startListener",
    ]) {
      this.failWith.set(name, new DriverError("exited", "the input driver stopped (process exited)"));
    }
  }

  /** The input commands sent, in order. */
  inputs(): string[] {
    return this.log.filter((entry) => INPUT_COMMANDS.includes(entry.split(" ")[0]));
  }

  count(name: string): number {
    return this.counts.get(name) ?? 0;
  }

  private async call<T>(name: string, detail: string, run: () => T): Promise<T> {
    this.log.push(detail ? `${name} ${detail}` : name);
    const n = (this.counts.get(name) ?? 0) + 1;
    this.counts.set(name, n);
    if (this.hang.has(name)) {
      this.hang.delete(name);
      return new Promise<T>(() => {});
    }
    const failure = this.failWith.get(name);
    if (failure) throw failure;
    const value = run();
    await this.on[name]?.(n);
    return value;
  }

  init() { return this.call("init", "", () => this.initResult); }
  logosWindow() { return this.call("logosWindow", "", () => this.window); }
  inputAvailable() { return this.call("inputAvailable", "", () => this.inputOk); }
  typeText(text: string) { return this.call("typeText", JSON.stringify(text), () => {}); }
  pressEnter() { return this.call("pressEnter", "", () => {}); }
  focusedControl() { return this.call("focusedControl", "", () => this.focused); }
  foreground() { return this.call("foreground", "", () => this.foregroundHandle); }
  focus(handle: string) {
    return this.call("focus", handle, () => {
      if (this.focusWorks) this.foregroundHandle = handle;
    });
  }
  cursor() { return this.call("cursor", "", () => this.cursorPos); }
  tabs() { return this.call("tabs", "", () => [...this.tabList]); }
  startListener() { return this.call("startListener", "", () => this.listenerStarts); }
  onUserInput(callback: () => void): void {
    this.userInput = callback;
  }
  async close(): Promise<void> {
    this.log.push("close");
    this.closed = true;
  }
  kill(): void {
    this.log.push("kill");
    this.killed = true;
    this.crash();
  }
}
