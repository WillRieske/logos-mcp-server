import { launchLogosUrl } from "./logos-app.js";
import { snapshotHistory, waitForHistoryVisit } from "./study-data.js";
import { withUiLock } from "../utils/ui-lock.js";
import type { HistoryConfirmation, HistoryTarget, LogosCommandResult } from "../types.js";

// Every link the server opens goes through here (withdrawn copy design §3.2,
// in history at 16da723): snapshot
// Logos's history, send the link, wait for Logos to record the visit. Holders
// of the UI lock call the unlocked variant.

/** What openAndConfirm and openAndConfirmUnlocked return. */
export interface OpenOutcome {
  launch: LogosCommandResult;
  /** "unavailable" when not confirmed (confirm false, launch failed, or no history.db). */
  confirmation: HistoryConfirmation;
}

/** How to send the link. */
export interface OpenOptions {
  /** Check history.db for the visit; false sends the link only. */
  confirm: boolean;
  /** Passed to the launch; defaults to LOGOS_RESTORE_FOCUS. */
  restoreFocus?: boolean;
}

/** History and launch access; replaced in tests. */
export interface OpenConfirmDeps {
  snapshot: typeof snapshotHistory;
  launch: typeof launchLogosUrl;
  wait: typeof waitForHistoryVisit;
}

const defaultDeps: OpenConfirmDeps = {
  snapshot: snapshotHistory,
  launch: launchLogosUrl,
  wait: waitForHistoryVisit,
};

/**
 * Sends a link and, when asked, confirms it through Logos's history. The
 * caller must already hold the UI lock.
 *
 * @param target - What the link opens, for matching history rows; null when not confirming.
 * @param build - Builds the link; may throw (reported as a failed launch).
 * @param options - Whether to confirm, and the focus-restore choice.
 * @param deps - Replaced in tests.
 * @returns The launch result and the confirmation outcome.
 */
export async function openAndConfirmUnlocked(
  target: HistoryTarget | null,
  build: () => string,
  options: OpenOptions,
  deps: OpenConfirmDeps = defaultDeps
): Promise<OpenOutcome> {
  const confirming = options.confirm && target !== null;
  const before = confirming ? deps.snapshot(target) : null;
  const launch = await deps.launch(build, { restoreFocus: options.restoreFocus });
  if (!launch.success || !confirming) {
    return { launch, confirmation: { status: "unavailable" } };
  }
  return { launch, confirmation: await deps.wait(target, before) };
}

/**
 * `openAndConfirmUnlocked` inside the UI lock, for the open tools.
 *
 * @param target - What the link opens; null when not confirming.
 * @param build - Builds the link.
 * @param options - Whether to confirm, and the focus-restore choice.
 * @param deps - Replaced in tests.
 * @returns The launch result and the confirmation outcome.
 */
export function openAndConfirm(
  target: HistoryTarget | null,
  build: () => string,
  options: OpenOptions,
  deps: OpenConfirmDeps = defaultDeps
): Promise<OpenOutcome> {
  return withUiLock(() => openAndConfirmUnlocked(target, build, options, deps));
}
