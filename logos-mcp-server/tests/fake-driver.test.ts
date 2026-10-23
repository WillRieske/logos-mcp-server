import { describe, it, expect } from "vitest";
import { FakeDriver } from "./helpers/fake-driver.js";
import { DriverError } from "../src/services/ui-driver.js";

describe("FakeDriver", () => {
  it("lists only input commands, in order", async () => {
    const fake = new FakeDriver();
    await fake.foreground();
    await fake.cursor();
    await fake.typeText("hope");
    await fake.pressEnter();
    await fake.focus("100");
    expect(fake.inputs()).toEqual(['typeText "hope"', "pressEnter", "focus 100"]);
  });

  it("fails, hangs once, or crashes on request", async () => {
    const fake = new FakeDriver();
    fake.failWith.set("pressEnter", new DriverError("input_blocked", "blocked"));
    await expect(fake.pressEnter()).rejects.toMatchObject({ code: "input_blocked" });
    fake.hang.add("cursor");
    let settled = false;
    void fake.cursor().then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    expect(await fake.cursor()).toEqual(fake.cursorPos);
    fake.kill();
    await expect(fake.foreground()).rejects.toMatchObject({ code: "exited" });
    expect(fake.killed && fake.log.includes("kill")).toBe(true);
  });

  it("brings a window forward only when focus works", async () => {
    const fake = new FakeDriver();
    fake.focusWorks = false;
    await fake.focus("100");
    expect(await fake.foreground()).toBe("555");
    fake.focusWorks = true;
    await fake.focus("100");
    expect(await fake.foreground()).toBe("100");
  });
});
