import { describe, it, expect, vi, afterEach } from "vitest";
import { withUiLock, UiLockTimeoutError, UI_LOCK_TIMEOUT_MESSAGE } from "../src/utils/ui-lock.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.useRealTimers();
});

describe("withUiLock", () => {
  it("runs callers one at a time, in order", async () => {
    const log: string[] = [];
    const a = withUiLock(async () => {
      log.push("a start");
      await sleep(20);
      log.push("a end");
    });
    const b = withUiLock(async () => {
      log.push("b start");
      log.push("b end");
    });
    await Promise.all([a, b]);
    expect(log).toEqual(["a start", "a end", "b start", "b end"]);
  });

  it("makes an open wait until a running copy finishes", async () => {
    const log: string[] = [];
    let finishCopy!: () => void;
    const copy = withUiLock(async () => {
      log.push("copy");
      await new Promise<void>((r) => (finishCopy = r));
      log.push("copy done");
    });
    const open = withUiLock(async () => {
      log.push("open_resource");
    });
    await sleep(10);
    expect(log).toEqual(["copy"]);
    finishCopy();
    await Promise.all([copy, open]);
    expect(log).toEqual(["copy", "copy done", "open_resource"]);
  });

  it("gives a holder's rejection to its own caller only", async () => {
    const failing = withUiLock(async () => {
      throw new Error("boom");
    });
    const next = withUiLock(async () => "next ran");
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("next ran");
  });

  it("returns the holder's value", async () => {
    await expect(withUiLock(async () => 42)).resolves.toBe(42);
  });

  it("aborts a holder that passes maxHoldMs and lets the next caller run", async () => {
    vi.useFakeTimers();
    let seenSignal: AbortSignal | undefined;
    const stuck = withUiLock(
      (signal) => {
        seenSignal = signal;
        return new Promise<never>(() => {});
      },
      { maxHoldMs: 1_000, settleMs: 100 }
    );
    const stuckResult = stuck.catch((e: unknown) => e);
    const next = withUiLock(async () => "next ran");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(seenSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    const error = await stuckResult;
    expect(error).toBeInstanceOf(UiLockTimeoutError);
    expect((error as Error).message).toBe(UI_LOCK_TIMEOUT_MESSAGE);
    await expect(next).resolves.toBe("next ran");
  });

  it("releases as soon as an aborted holder settles", async () => {
    vi.useFakeTimers();
    const holder = withUiLock(
      (signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("stopped")));
        }),
      { maxHoldMs: 500, settleMs: 2_000 }
    );
    const holderResult = holder.catch((e: unknown) => e);
    const next = withUiLock(async () => "next ran");
    await vi.advanceTimersByTimeAsync(500);
    expect(await holderResult).toBeInstanceOf(UiLockTimeoutError);
    await expect(next).resolves.toBe("next ran");
  });

  // A holder that ignores the abort and rejects after the lock has moved on
  // must not surface as an unhandled rejection (which would crash a server
  // run with --unhandled-rejections=strict), whichever handler absorbs it.
  it("absorbs a late rejection from a holder that ignores the abort", async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const late = withUiLock(
        () => new Promise<never>((_, reject) => setTimeout(() => reject(new Error("late")), 2_100)),
        { maxHoldMs: 1_000, settleMs: 100 }
      );
      const lateResult = late.catch((e: unknown) => e);
      const next = withUiLock(async () => "next ran");
      await vi.advanceTimersByTimeAsync(1_100);
      expect(await lateResult).toBeInstanceOf(UiLockTimeoutError);
      await expect(next).resolves.toBe("next ran");
      // The holder rejects now, a second after the lock moved on.
      await vi.advanceTimersByTimeAsync(1_000);
      vi.useRealTimers();
      await sleep(10); // let Node report any unhandled rejection
      expect(unhandled).toEqual([]);
      await expect(withUiLock(async () => "third ran")).resolves.toBe("third ran");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
