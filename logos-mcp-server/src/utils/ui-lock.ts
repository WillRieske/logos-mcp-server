import { UI_LOCK_LIMITS } from "../config.js";

// Serialises everything that drives the Logos UI in this server process:
// opens and word-study typing (withdrawn copy design §3.2, in history at
// 16da723; adapted from robrawks#12). Not re-entrant: a composite takes the
// lock once and calls the unlocked internals. The lock does not cover other
// server processes; the input driver adds a named mutex for that
// (withdrawn copy design §3.5, in history at 16da723).

export const UI_LOCK_TIMEOUT_MESSAGE = "the Logos UI operation timed out and was stopped";

/** The holder of the UI lock passed its maximum hold time and was stopped. */
export class UiLockTimeoutError extends Error {
  constructor() {
    super(UI_LOCK_TIMEOUT_MESSAGE);
    this.name = "UiLockTimeoutError";
  }
}

let tail: Promise<void> = Promise.resolve();

/**
 * Runs `fn` once every earlier holder has finished. A holder's rejection goes
 * to its own caller only. When `fn` holds the lock longer than `maxHoldMs`,
 * its signal is aborted, it gets up to `settleMs` to settle, the lock moves on
 * and this call rejects with `UiLockTimeoutError`.
 *
 * @param fn - The UI operation; it should stop promptly when `signal` aborts.
 * @param options.maxHoldMs - Defaults to `UI_LOCK_LIMITS.maxHoldMs` (60 s).
 * @param options.settleMs - Defaults to `UI_LOCK_LIMITS.settleMs` (2 s).
 * @returns What `fn` returns.
 */
export async function withUiLock<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: { maxHoldMs?: number; settleMs?: number } = {}
): Promise<T> {
  const maxHoldMs = options.maxHoldMs ?? UI_LOCK_LIMITS.maxHoldMs;
  const settleMs = options.settleMs ?? UI_LOCK_LIMITS.settleMs;

  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const previous = tail;
  tail = previous.then(() => mine);
  await previous;

  const controller = new AbortController();
  const run = Promise.resolve().then(() => fn(controller.signal));
  // We may stop waiting for `run`; keep its later rejection handled.
  run.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), maxHoldMs);
  });
  try {
    const first = await Promise.race([run.then((value) => ({ value })), expired]);
    if (first !== "expired") return first.value;
    controller.abort(new UiLockTimeoutError());
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      run.then(() => {}, () => {}),
      new Promise<void>((resolve) => {
        settleTimer = setTimeout(resolve, settleMs);
      }),
    ]);
    clearTimeout(settleTimer);
    throw new UiLockTimeoutError();
  } finally {
    clearTimeout(timer);
    release();
  }
}
