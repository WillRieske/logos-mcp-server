import { DRIVER_LIMITS, LOGOS_RESTORE_FOCUS, WORD_STUDY_LIMITS, type DriverLimits, type WordStudyLimits } from "../config.js";
import { withUiLock, UI_LOCK_TIMEOUT_MESSAGE } from "../utils/ui-lock.js";
import { validateWord } from "../utils/word-input.js";
import { launchLogosUrl } from "./logos-app.js";
import { buildWordStudyUrl } from "./logos-urls.js";
import { snapshotHistory, waitForHistoryVisit, wordStudyMatches } from "./study-data.js";
import { createUiDriver, DriverError, driverReason, type LogosWindowInfo, type Point, type UiDriver } from "./ui-driver.js";
import type { HistoryConfirmation, HistoryTarget, ListenerState } from "../types.js";

// open_word_study on Windows (design 2026-10-18): Logos ignores a word in a
// link, but an empty Bible Word Study opens with its word box focused and
// selected, so the word is typed and Enter pressed.
// Input-safety rules: Logos is checked to be in front before every key, a
// takeover stops all input, and the user's window comes back
// (withdrawn copy design §3.5, in history at 16da723). No mouse and no
// clipboard are used.

/** The run failed before it typed anything; `warnings` holds cleanup problems. */
export class WordStudyError extends Error {
  constructor(message: string, readonly warnings: string[] = []) {
    super(message);
    this.name = "WordStudyError";
  }
}

/** What to study. */
export interface WordStudyRequest {
  /** As typed into the word box: "hope", or "g:agape" / "h:hesed" for Greek / Hebrew. */
  word: string;
  /** The user agreed to the input listener (withdrawn copy design §3.9, in history at 16da723). */
  listenerConsent: boolean;
  /** The MCP request's abort signal. */
  signal?: AbortSignal;
}

/**
 * How far the run got: none (nothing sent to Logos), launching (the link
 * was sent; a tab may have opened), opened (empty study, nothing
 * typed), typing (some characters may be in the box), typed (all typed, no
 * Enter), entering (Enter may have been sent), entered (Enter sent).
 */
export type WordStudyStage = "none" | "launching" | "opened" | "typing" | "typed" | "entering" | "entered";

/**
 * ran: Logos recorded this word. different: it recorded another.
 * unconfirmed: Enter was sent but no history row appeared. unavailable:
 * Enter was sent and history could not be read. interrupted: stopped early.
 */
export type WordStudyStatus = "ran" | "different" | "unconfirmed" | "unavailable" | "interrupted";

/** The outcome of open_word_study's typing. */
export interface WordStudyResult {
  word: string;
  status: WordStudyStatus;
  stage: WordStudyStage;
  /** What Logos recorded for the study (its history subtitle), when known. */
  recorded?: string;
  /** Why the run stopped, for "interrupted". */
  reason?: string;
  listener: ListenerState;
  warnings: string[];
}

/** Everything the run reaches outside itself; replaced in tests. */
export interface WordStudyDeps {
  createDriver(): Promise<UiDriver>;
  snapshot: typeof snapshotHistory;
  launch: typeof launchLogosUrl;
  wait: typeof waitForHistoryVisit;
  limits: DriverLimits;
  wordStudyLimits: WordStudyLimits;
  /** Put the user's window back afterwards (LOGOS_RESTORE_FOCUS). */
  restoreFocus: boolean;
}

const defaultDeps: WordStudyDeps = {
  createDriver: () => createUiDriver(),
  snapshot: snapshotHistory,
  launch: launchLogosUrl,
  wait: waitForHistoryVisit,
  limits: DRIVER_LIMITS,
  wordStudyLimits: WORD_STUDY_LIMITS,
  restoreFocus: LOGOS_RESTORE_FOCUS,
};

const TAKEOVER_REASON = "you used the mouse/keyboard (or switched windows); stopped";
const CANCELLED_REASON = "the request was cancelled";
const TIME_REASON = "time limit reached";
const STUDY_TAB = "Bible Word Study";

type StopReason = "deadline" | "cancelled" | "lock" | "takeover";

/** Thrown inside the run when the stop signal fires. */
class Stopped extends Error {
  constructor() {
    super("stopped");
  }
}

/**
 * Types a word into a new Bible Word Study, inside the UI lock.
 *
 * @param request - The word, consent and the request's abort signal.
 * @param deps - Replaced in tests.
 * @returns How the run ended.
 * @throws WordStudyError for failures before anything was typed; UiLockTimeoutError when the lock gave up.
 */
export function runWordStudy(request: WordStudyRequest, deps: WordStudyDeps = defaultDeps): Promise<WordStudyResult> {
  return withUiLock((lockSignal) => runWordStudyUnlocked(request, lockSignal, deps), {
    maxHoldMs: deps.wordStudyLimits.lockMaxHoldMs,
    settleMs: deps.wordStudyLimits.lockSettleMs,
  });
}

/**
 * The run, for a caller that already holds the UI lock.
 *
 * @param request - As for `runWordStudy`.
 * @param lockSignal - Aborted when the lock gives up on this holder; the driver is then killed.
 * @param deps - Replaced in tests.
 * @returns How the run ended.
 */
export function runWordStudyUnlocked(
  request: WordStudyRequest,
  lockSignal: AbortSignal,
  deps: WordStudyDeps = defaultDeps
): Promise<WordStudyResult> {
  return new WordStudyRun(request, lockSignal, deps).execute();
}

class WordStudyRun {
  private readonly stop = new AbortController();
  private stopReason: StopReason | null = null;
  private tookOver = false;
  private driver: UiDriver | null = null;
  private window: LogosWindowInfo | null = null;
  private savedForeground: string | null = null;
  /** Where the user left the cursor; the run never moves it. */
  private cursorAt: Point | null = null;
  /** The launch (which can change the foreground window) has been sent. */
  private focusTouched = false;
  /** An input command is in flight: a stop must end the driver, or the script keeps sending keys. */
  private sending = false;
  private stage: WordStudyStage = "none";
  private listener: ListenerState = "off";
  private readonly warnings: string[] = [];
  private word = "";

  constructor(
    private readonly request: WordStudyRequest,
    private readonly lockSignal: AbortSignal,
    private readonly deps: WordStudyDeps
  ) {}

  async execute(): Promise<WordStudyResult> {
    try {
      this.word = validateWord(this.request.word);
    } catch (e) {
      throw new WordStudyError(e instanceof Error ? e.message : String(e));
    }
    const deadline = setTimeout(() => this.fire("deadline"), this.deps.wordStudyLimits.timeLimitMs);
    const onCancel = () => this.fire("cancelled");
    const onLock = () => {
      this.fire("lock");
      this.driver?.kill();
    };
    if (this.request.signal?.aborted) onCancel();
    this.request.signal?.addEventListener("abort", onCancel);
    this.lockSignal.addEventListener("abort", onLock);
    if (this.lockSignal.aborted) onLock();
    try {
      const result = await this.study();
      clearTimeout(deadline);
      await this.cleanup();
      return { ...result, warnings: [...this.warnings] };
    } catch (e) {
      clearTimeout(deadline);
      await this.cleanup();
      throw new WordStudyError(e instanceof Error ? e.message : String(e), [...this.warnings]);
    } finally {
      this.request.signal?.removeEventListener("abort", onCancel);
      this.lockSignal.removeEventListener("abort", onLock);
    }
  }

  // ─── The steps ─────────────────────────────────────────────────────────────

  private async study(): Promise<WordStudyResult> {
    const target: HistoryTarget = { kind: "wordstudy", word: this.word };
    try {
      await this.preflight();
      const studyTabsBefore = this.studyTabs(await this.guarded(this.drv().tabs()));
      this.focusTouched = true;
      this.stage = "launching";
      const launch = await this.guarded(
        this.deps.launch(() => buildWordStudyUrl(this.word, "current"), { restoreFocus: false })
      );
      if (!launch.success) throw new WordStudyError(`Failed to open Bible Word Study: ${launch.error}`);
      this.stage = "opened";
      await this.waitForNewTab(studyTabsBefore);
      await this.sleep(this.deps.wordStudyLimits.focusSettleMs);
      await this.bringLogosForward();

      await this.ensureSafe();
      // Taken now, with the empty study open, so its own history row (if Logos writes one) is not mistaken for the typed study.
      const before = this.deps.snapshot(target);
      const focus = await this.guarded(this.drv().focusedControl());
      if (focus.control !== "Edit" || !focus.inLogos) {
        const found = focus.inLogos ? focus.control || "nothing" : "a control outside the Logos main window";
        throw new WordStudyError(
          `The new Bible Word Study's word box did not have the keyboard focus (${found} did), so nothing was typed. Type "${this.word}" into it yourself.`
        );
      }

      await this.input(() => {
        this.stage = "typing";
        return this.drv().typeText(this.word);
      });
      this.stage = "typed";
      await this.input(() => {
        this.stage = "entering";
        return this.drv().pressEnter();
      });
      this.stage = "entered";

      const confirmation = await this.guarded(this.deps.wait(target, before));
      return this.result(confirmation);
    } catch (e) {
      return this.handleStop(e);
    }
  }

  /** Turns a stop or driver failure into the run's result, or rethrows it. */
  private handleStop(e: unknown): WordStudyResult {
    if (e instanceof Stopped) {
      return this.interrupted(
        this.stopReason === "deadline"
          ? TIME_REASON
          : this.stopReason === "takeover"
            ? TAKEOVER_REASON
            : this.stopReason === "lock"
              ? UI_LOCK_TIMEOUT_MESSAGE
              : CANCELLED_REASON
      );
    }
    if (e instanceof DriverError && e.code === "foreground_changed") {
      this.fire("takeover");
      return this.interrupted(TAKEOVER_REASON);
    }
    if (e instanceof DriverError) {
      const why = driverReason(e);
      if (this.stage === "none" || this.stage === "launching" || this.stage === "opened") {
        const lead = `${why[0].toUpperCase()}${why.slice(1)}`;
        throw new WordStudyError(
          this.stage === "none" ? `${lead}; nothing was opened.` : `${lead}; nothing was typed (a Bible Word Study may be open).`
        );
      }
      return this.interrupted(why);
    }
    throw e;
  }

  private interrupted(reason: string): WordStudyResult {
    return { word: this.word, status: "interrupted", stage: this.stage, reason, listener: this.listener, warnings: [] };
  }

  private result(confirmation: HistoryConfirmation): WordStudyResult {
    const base = { word: this.word, stage: this.stage, listener: this.listener, warnings: [] };
    if (confirmation.status === "unconfirmed" || confirmation.status === "unavailable") {
      return { ...base, status: confirmation.status };
    }
    if (confirmation.status === "already_open") {
      // Logos was already showing this study, so a new row was never expected: Enter may have done nothing.
      this.warnings.push("Logos was already showing this word, so no new history row appeared to prove Enter ran the study");
      return { ...base, status: "unconfirmed" };
    }
    const recorded = confirmation.visit.subtitle ?? confirmation.visit.title;
    return { ...base, status: wordStudyMatches(confirmation.visit, this.word) ? "ran" : "different", recorded };
  }

  private async preflight(): Promise<void> {
    this.driver = await this.deps.createDriver();
    const driver = this.driver;
    if (this.lockSignal.aborted) driver.kill();
    driver.onUserInput(() => this.fire("takeover"));
    const init = await this.guarded(driver.init());
    if (init.busy) throw new WordStudyError("Another Logos MCP input operation is running; try again when it finishes.");
    if (!init.perMonitorAware) throw new WordStudyError("screen scaling could not be handled; stopped before any input");
    const win = await this.guarded(driver.logosWindow());
    if (!win.found) throw new WordStudyError("No Logos window was found. Is Logos open with a window showing?");
    if (win.minimized) throw new WordStudyError("The Logos window is minimized; restore it, then retry.");
    this.window = win;
    if (!(await this.guarded(driver.inputAvailable()))) {
      throw new WordStudyError("Windows is blocking input: the PC may be locked, or Logos may be running as administrator.");
    }
    this.savedForeground = await this.guarded(driver.foreground());
    // Typing is checked against where the user left the cursor (withdrawn copy design §3.5, in history at 16da723).
    this.cursorAt = await this.guarded(driver.cursor());
    if (this.request.listenerConsent) {
      this.listener = (await this.guarded(driver.startListener())) ? "on" : "unavailable";
    }
  }

  private studyTabs(tabs: string[]): number {
    return tabs.filter((t) => t.startsWith(STUDY_TAB)).length;
  }

  /** Waits for the launch to add a Bible Word Study tab; a busy Logos can ignore the link (F20). */
  private async waitForNewTab(before: number): Promise<void> {
    const { tabWaitMs, tabPollMs } = this.deps.wordStudyLimits;
    const until = Date.now() + tabWaitMs;
    for (;;) {
      if (this.studyTabs(await this.guarded(this.drv().tabs())) > before) return;
      if (Date.now() >= until) break;
      await this.sleep(tabPollMs);
    }
    throw new WordStudyError(
      "Logos did not open a new Bible Word Study tab, so nothing was typed. Logos may be busy; wait a moment and retry."
    );
  }

  private async bringLogosForward(): Promise<void> {
    const handle = this.win().handle;
    if ((await this.guarded(this.drv().foreground())) === handle) return;
    await this.guarded(this.drv().focus(handle));
    if ((await this.guarded(this.drv().foreground())) !== handle) {
      throw new WordStudyError("Logos did not come to the front, so nothing was typed; click the Logos window and retry.");
    }
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  private async cleanup(): Promise<void> {
    const driver = this.driver;
    if (!driver) return;
    const saved = this.savedForeground;
    const wants = this.deps.restoreFocus && this.focusTouched && saved !== null && saved !== this.window?.handle;
    if (wants) {
      // The fallback takeover check guards cleanup's input too (withdrawn copy design §3.5, in history at 16da723).
      if (!this.tookOver && !(await this.cleanupInputSafe())) this.tookOver = true;
      if (this.tookOver) {
        this.warnings.push("your window was not restored because you used the mouse/keyboard");
      } else {
        try {
          await driver.focus(saved as string);
        } catch (e) {
          if (e instanceof DriverError && e.code === "foreground_changed") {
            this.warnings.push("your window was not restored because you used the mouse/keyboard");
          } else if (e instanceof DriverError && e.code !== "command") {
            this.warnings.push(`your window was not restored: ${driverReason(e)}`);
          } else {
            this.warnings.push(`could not restore your window: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    }
    try {
      await driver.close();
    } catch {
      // The driver is gone either way.
    }
  }

  /**
   * The fallback check for cleanup's input; never throws. Logos must still be
   * in front and the cursor where the user left it. A driver that can't
   * answer passes: the focus step then fails on its own and says so.
   */
  private async cleanupInputSafe(): Promise<boolean> {
    try {
      const driver = this.drv();
      if ((await driver.foreground()) !== this.win().handle) return false;
      return this.cursorStill(await driver.cursor());
    } catch {
      return true;
    }
  }

  // ─── Plumbing ──────────────────────────────────────────────────────────────

  private fire(reason: StopReason): void {
    if (reason === "takeover") this.tookOver = true;
    if (this.stopReason) return;
    this.stopReason = reason;
    this.stop.abort();
    // The driver script cannot hear the stop: end it so no more keys are sent.
    if (this.sending && reason !== "lock") this.driver?.kill();
  }

  /** Races `promise` against the stop signal. */
  private guarded<T>(promise: Promise<T>): Promise<T> {
    const signal = this.stop.signal;
    if (signal.aborted) {
      promise.catch(() => {});
      return Promise.reject(new Stopped());
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new Stopped());
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  private sleep(ms: number): Promise<void> {
    return this.guarded(new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  private cursorStill(at: Point): boolean {
    if (!this.cursorAt) return true;
    const tolerance = this.deps.limits.cursorTolerancePx;
    return Math.abs(at.x - this.cursorAt.x) <= tolerance && Math.abs(at.y - this.cursorAt.y) <= tolerance;
  }

  /** Logos must be in front and the cursor where the user left it, else a takeover. */
  private async ensureSafe(): Promise<void> {
    if (this.stop.signal.aborted) throw new Stopped();
    if ((await this.guarded(this.drv().foreground())) !== this.win().handle) return this.takeover();
    if (!this.cursorStill(await this.guarded(this.drv().cursor()))) return this.takeover();
  }

  /** Sends one input command after the fallback takeover check; "foreground_changed" is a takeover too. */
  private async input(send: () => Promise<void>): Promise<void> {
    await this.ensureSafe();
    this.sending = true;
    try {
      await this.guarded(send());
    } catch (e) {
      if (e instanceof DriverError && e.code === "foreground_changed") return this.takeover();
      throw e;
    } finally {
      this.sending = false;
    }
  }

  private takeover(): never {
    this.fire("takeover");
    throw new Stopped();
  }

  private drv(): UiDriver {
    if (!this.driver) throw new Error("the input driver has not started");
    return this.driver;
  }

  private win(): LogosWindowInfo {
    if (!this.window) throw new Error("the Logos window is unknown");
    return this.window;
  }
}
