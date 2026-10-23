import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FakeDriver } from "./helpers/fake-driver.js";
import {
  runWordStudyUnlocked,
  WordStudyError,
  type WordStudyDeps,
  type WordStudyRequest,
  type WordStudyResult,
} from "../src/services/word-study.js";
import { DRIVER_LIMITS, WORD_STUDY_LIMITS } from "../src/config.js";
import { DriverError } from "../src/services/ui-driver.js";
import type { HistoryConfirmation, HistoryVisit } from "../src/types.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const visit = (subtitle: string | null): HistoryVisit => ({
  id: "w9",
  title: "Bible Word Study",
  subtitle,
  lastVisited: "2026-10-18T07:00:00Z",
  kind: "Guides",
  resourceId: null,
  rawReference: null,
  reference: null,
});

interface SetupOptions {
  word?: string;
  confirmation?: HistoryConfirmation;
  restoreFocus?: boolean;
  listenerConsent?: boolean;
  opensTab?: boolean;
}

function setup(options: SetupOptions = {}) {
  const fake = new FakeDriver();
  const word = options.word ?? "hope";
  const calls: string[] = [];
  const deps: WordStudyDeps = {
    createDriver: async () => fake,
    snapshot: () => {
      calls.push("snapshot");
      return { ids: new Set(["old"]), alreadyShowing: null };
    },
    launch: async (build, launchOptions) => {
      calls.push(`launch ${build()} restoreFocus=${String(launchOptions?.restoreFocus)}`);
      fake.foregroundHandle = "100";
      if (options.opensTab !== false) fake.tabList.push("Bible Word Study");
      return { success: true, command: build() };
    },
    wait: async () => {
      calls.push("wait");
      return options.confirmation ?? { status: "confirmed", visit: visit(word) };
    },
    limits: DRIVER_LIMITS,
    wordStudyLimits: WORD_STUDY_LIMITS,
    restoreFocus: options.restoreFocus ?? true,
  };
  const request: WordStudyRequest = { word, listenerConsent: options.listenerConsent ?? false };
  return { fake, deps, request, calls };
}

async function run(request: WordStudyRequest, deps: WordStudyDeps, lockSignal = new AbortController().signal) {
  const settled = runWordStudyUnlocked(request, lockSignal, deps).then(
    (result) => ({ result, error: null as unknown }),
    (error: unknown) => ({ result: null as WordStudyResult | null, error })
  );
  await vi.runAllTimersAsync();
  return settled;
}

const TYPING = ["typeText", "pressEnter"];
const sent = (fake: FakeDriver) => fake.log.filter((l) => TYPING.includes(l.split(" ")[0]));

describe("runWordStudy: the run", () => {
  it("opens the study, checks the word box, types the word, presses Enter and confirms by history", async () => {
    const { fake, deps, request, calls } = setup();
    const { result } = await run(request, deps);
    expect(result).toMatchObject({ word: "hope", status: "ran", recorded: "hope", stage: "entered", listener: "off", warnings: [] });
    // The snapshot comes after the empty study opens, so its own history row is not counted as the typed study.
    expect(calls).toEqual(["launch logos4:Guide;t=Bible%20Word%20Study restoreFocus=false", "snapshot", "wait"]);
    expect(sent(fake)).toEqual(['typeText "hope"', "pressEnter"]);
    expect(fake.log.indexOf("focusedControl")).toBeLessThan(fake.log.indexOf('typeText "hope"'));
  });

  it("never touches the mouse or the clipboard", async () => {
    const { fake, deps, request } = setup();
    await run(request, deps);
    expect(fake.log.join()).not.toMatch(/click|shiftClick|drag|wheel|copy|Clipboard/i);
    expect(fake.closed).toBe(true);
  });

  it("types Greek input as given and accepts the lemma Logos records", async () => {
    const { fake, deps, request } = setup({ word: "g:agape", confirmation: { status: "confirmed", visit: visit("ἀγάπη") } });
    const { result } = await run(request, deps);
    expect(sent(fake)[0]).toBe('typeText "g:agape"');
    expect(result).toMatchObject({ status: "ran", recorded: "ἀγάπη" });
  });

  it("says so when Logos recorded a different word", async () => {
    const { deps, request } = setup({ confirmation: { status: "confirmed", visit: visit("grace") } });
    const { result } = await run(request, deps);
    expect(result).toMatchObject({ status: "different", recorded: "grace", stage: "entered" });
  });

  it("does not call an already-open study a run: no new row proves Enter did anything", async () => {
    const { deps, request } = setup({ confirmation: { status: "already_open", visit: visit("hope") } });
    const { result } = await run(request, deps);
    expect(result).toMatchObject({ status: "unconfirmed", stage: "entered" });
    expect(result!.warnings.join()).toMatch(/already showing this word/);
  });

  it("does not accept the generic study title as the Greek lemma", async () => {
    const { deps, request } = setup({ word: "g:agape", confirmation: { status: "confirmed", visit: visit("Bible Word Study") } });
    expect((await run(request, deps)).result).toMatchObject({ status: "different" });
  });

  it("reports an unconfirmed or unverifiable run without claiming success", async () => {
    for (const status of ["unconfirmed", "unavailable"] as const) {
      const { deps, request } = setup({ confirmation: { status } });
      const { result } = await run(request, deps);
      expect(result).toMatchObject({ status, stage: "entered" });
      expect(result!.recorded).toBeUndefined();
    }
  });

  it("starts the listener only with consent", async () => {
    const on = setup({ listenerConsent: true });
    expect((await run(on.request, on.deps)).result!.listener).toBe("on");
    const off = setup();
    await run(off.request, off.deps);
    expect(off.fake.count("startListener")).toBe(0);
    const failing = setup({ listenerConsent: true });
    failing.fake.listenerStarts = false;
    expect((await run(failing.request, failing.deps)).result!.listener).toBe("unavailable");
  });

  it("refuses an invalid word before any driver work", async () => {
    for (const word of ["", "a\nb"]) {
      const { fake, deps, request } = setup({ word });
      const { error } = await run(request, deps);
      expect(error).toBeInstanceOf(WordStudyError);
      expect(fake.log).toEqual([]);
    }
  });
});

describe("runWordStudy: refusals before anything opens", () => {
  const cases: Array<[string, (f: FakeDriver) => void, RegExp]> = [
    ["another copy holds the driver", (f) => { f.initResult = { perMonitorAware: true, busy: true }; }, /Another Logos MCP/],
    ["screen scaling can't be handled", (f) => { f.initResult = { perMonitorAware: false, busy: false }; }, /scaling/],
    ["no Logos window", (f) => { f.window = { ...f.window, found: false }; }, /No Logos window/],
    ["minimized", (f) => { f.window = { ...f.window, minimized: true }; }, /minimized/],
    ["input blocked", (f) => { f.inputOk = false; }, /blocking input/],
  ];
  for (const [name, arrange, message] of cases) {
    it(`stops when ${name}, without launching or typing`, async () => {
      const { fake, deps, request, calls } = setup();
      arrange(fake);
      const { error } = await run(request, deps);
      expect(error).toBeInstanceOf(WordStudyError);
      expect((error as Error).message).toMatch(message);
      expect(calls).toEqual([]);
      expect(sent(fake)).toEqual([]);
      expect(fake.closed).toBe(true);
    });
  }
});

describe("runWordStudy: before typing", () => {
  it("types nothing when no new Bible Word Study tab appears", async () => {
    const { fake, deps, request } = setup({ opensTab: false });
    const { error } = await run(request, deps);
    expect((error as Error).message).toMatch(/did not open a new Bible Word Study tab/);
    expect(sent(fake)).toEqual([]);
  });

  it("counts a second Bible Word Study tab as new", async () => {
    const { fake, deps, request } = setup();
    fake.tabList = ["Bible Word Study | mercy"];
    expect((await run(request, deps)).result).toMatchObject({ status: "ran" });
  });

  it("types nothing when the focused control is not an edit box", async () => {
    const { fake, deps, request, calls } = setup();
    fake.focused = { control: "Pane", inLogos: true };
    const { error } = await run(request, deps);
    expect((error as Error).message).toMatch(/word box/);
    expect(sent(fake)).toEqual([]);
    expect(calls).not.toContain("wait");
  });

  it("types nothing when the focus is outside Logos", async () => {
    const { fake, deps, request } = setup();
    fake.focused = { control: "Edit", inLogos: false };
    const { error } = await run(request, deps);
    expect((error as Error).message).toMatch(/word box/);
    expect(sent(fake)).toEqual([]);
  });

  it("brings Logos forward if the open left it behind", async () => {
    const { fake, deps, request } = setup();
    const launch = deps.launch;
    deps.launch = async (build, o) => {
      const r = await launch(build, o);
      fake.foregroundHandle = "555";
      return r;
    };
    expect((await run(request, deps)).result).toMatchObject({ status: "ran" });
    expect(fake.log).toContain("focus 100");
  });

  it("refuses when Logos will not come to the front", async () => {
    const { fake, deps, request } = setup();
    const launch = deps.launch;
    deps.launch = async (build, o) => {
      const r = await launch(build, o);
      fake.foregroundHandle = "555";
      return r;
    };
    fake.focusWorks = false;
    const { error } = await run(request, deps);
    expect((error as Error).message).toMatch(/did not come to the front/);
    expect(sent(fake)).toEqual([]);
  });

  it("reports a failed launch", async () => {
    const { fake, deps, request } = setup();
    deps.launch = async () => ({ success: false, command: "", error: "no handler" });
    const { error } = await run(request, deps);
    expect((error as Error).message).toMatch(/Failed to open Bible Word Study: no handler/);
    expect(sent(fake)).toEqual([]);
  });
});

describe("runWordStudy: takeover and stops", () => {
  it("stops typing when the listener reports user input, and presses no Enter", async () => {
    const { fake, deps, request } = setup({ listenerConsent: true });
    fake.on.typeText = () => fake.emitUserInput();
    const { result } = await run(request, deps);
    expect(result).toMatchObject({ status: "interrupted", stage: "typing", reason: "you used the mouse/keyboard (or switched windows); stopped" });
    expect(sent(fake)).toEqual(['typeText "hope"']);
    expect(fake.log).not.toContain("focus 555");
    expect(result!.warnings.join()).toMatch(/not restored because you used the mouse\/keyboard/);
  });

  it("sends no input when the user has switched windows before typing", async () => {
    const { fake, deps, request } = setup();
    fake.on.focusedControl = () => { fake.foregroundHandle = "555"; };
    const { result } = await run(request, deps);
    expect(result).toMatchObject({ status: "interrupted", stage: "opened" });
    expect(sent(fake)).toEqual([]);
  });

  it("stops before Enter when the user switches windows after typing", async () => {
    const { fake, deps, request } = setup();
    fake.on.typeText = () => { fake.foregroundHandle = "555"; };
    const { result } = await run(request, deps);
    expect(result).toMatchObject({ status: "interrupted", stage: "typed" });
    expect(sent(fake)).toEqual(['typeText "hope"']);
  });

  it("stops when the cursor moved", async () => {
    const { fake, deps, request } = setup();
    fake.on.focusedControl = () => { fake.cursorPos = { x: 900, y: 900 }; };
    const { result } = await run(request, deps);
    expect(result).toMatchObject({ status: "interrupted", stage: "opened" });
    expect(sent(fake)).toEqual([]);
  });

  it("treats the driver's foreground_changed during typing as a takeover", async () => {
    const { fake, deps, request } = setup();
    fake.failWith.set("typeText", new DriverError("foreground_changed", "Logos lost the front"));
    const { result } = await run(request, deps);
    expect(result).toMatchObject({ status: "interrupted", stage: "typing" });
    expect(fake.count("pressEnter")).toBe(0);
  });

  it("ends the driver when a stop lands mid-typing, so no more keys are sent", async () => {
    for (const stop of ["takeover", "deadline", "cancel"] as const) {
      const { fake, deps, request } = setup({ listenerConsent: true });
      const controller = new AbortController();
      request.signal = controller.signal;
      fake.hang.add("typeText");
      fake.on.focusedControl = () => {
        setTimeout(() => (stop === "takeover" ? fake.emitUserInput() : controller.abort()), 100);
      };
      if (stop === "deadline") fake.on.focusedControl = undefined;
      const { result } = await run(request, deps);
      expect(fake.killed).toBe(true);
      expect(result).toMatchObject({ status: "interrupted", stage: "typing" });
      expect(fake.count("pressEnter")).toBe(0);
    }
  });

  it("does not kill the driver for a stop that lands between commands", async () => {
    const { fake, deps, request } = setup({ listenerConsent: true });
    fake.on.focusedControl = () => fake.emitUserInput();
    const { result } = await run(request, deps);
    expect(result).toMatchObject({ status: "interrupted", stage: "opened" });
    expect(fake.killed).toBe(false);
  });

  it("stops at the time limit", async () => {
    const { fake, deps, request } = setup();
    fake.hang.add("typeText");
    const { result } = await run(request, deps);
    expect(result).toMatchObject({ status: "interrupted", stage: "typing", reason: "time limit reached" });
    expect(fake.count("pressEnter")).toBe(0);
  });

  it("stops on cancellation", async () => {
    const { fake, deps, request } = setup();
    const controller = new AbortController();
    request.signal = controller.signal;
    fake.on.focusedControl = () => controller.abort();
    const { result } = await run(request, deps);
    expect(result).toMatchObject({ status: "interrupted", reason: "the request was cancelled" });
    expect(sent(fake)).toEqual([]);
  });

  it("kills the driver and stops when the UI lock gives up", async () => {
    const { fake, deps, request } = setup();
    const lock = new AbortController();
    fake.hang.add("typeText");
    fake.on.focusedControl = () => { setTimeout(() => lock.abort(), 100); };
    const { result } = await run(request, deps, lock.signal);
    expect(fake.killed).toBe(true);
    expect(result).toMatchObject({ status: "interrupted", reason: "the Logos UI operation timed out and was stopped" });
  });

  it("reports a driver that stops answering after the launch", async () => {
    const { fake, deps, request } = setup();
    fake.failWith.set("focusedControl", new DriverError("exited", "gone"));
    const { error } = await run(request, deps);
    expect(error).toBeInstanceOf(WordStudyError);
    expect((error as Error).message).toMatch(/input driver stopped responding/);
  });
});

describe("runWordStudy: putting the user's window back", () => {
  it("restores the user's window after the history check", async () => {
    const { fake, deps, request } = setup();
    const { result } = await run(request, deps);
    expect(fake.log.lastIndexOf("focus 555")).toBeGreaterThan(fake.log.indexOf("pressEnter"));
    expect(result!.warnings).toEqual([]);
  });

  it("leaves the window alone when restoring focus is off", async () => {
    const { fake, deps, request } = setup({ restoreFocus: false });
    await run(request, deps);
    expect(fake.log).not.toContain("focus 555");
  });

  it("does not restore after the user took over", async () => {
    const { fake, deps, request } = setup({ listenerConsent: true });
    fake.on.pressEnter = () => fake.emitUserInput();
    const { result } = await run(request, deps);
    expect(fake.log).not.toContain("focus 555");
    expect(result!.warnings.join()).toMatch(/not restored because you used the mouse\/keyboard/);
  });

  it("does not restore when the user is no longer in Logos at cleanup", async () => {
    const { fake, deps, request } = setup();
    fake.on.pressEnter = () => { fake.foregroundHandle = "777"; };
    const { result } = await run(request, deps);
    expect(fake.log).not.toContain("focus 555");
    expect(result!.warnings.join()).toMatch(/not restored/);
  });
});
