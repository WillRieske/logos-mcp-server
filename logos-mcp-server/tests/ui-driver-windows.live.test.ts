import { describe, it, expect, afterEach } from "vitest";
import { createWindowsDriver } from "../src/services/ui-driver-windows.js";
import type { UiDriver } from "../src/services/ui-driver.js";

// Runs the real driver script. Only with LOGOS_LIVE_DRIVER=1 on Windows. It
// never sends input to Logos.
const live = process.platform === "win32" && process.env.LOGOS_LIVE_DRIVER === "1";
const drivers: UiDriver[] = [];

async function start(): Promise<UiDriver> {
  const d = await createWindowsDriver();
  drivers.push(d);
  return d;
}

afterEach(async () => {
  for (const d of drivers.splice(0)) await d.close();
});

describe.runIf(live)("Windows driver (live)", () => {
  it("starts per-monitor DPI aware and owns the input mutex; a second driver is busy", async () => {
    const first = await start();
    expect(await first.init()).toEqual({ perMonitorAware: true, busy: false });
    const second = await start();
    expect((await second.init()).busy).toBe(true);
  }, 30_000);
});
