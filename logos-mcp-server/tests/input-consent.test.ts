import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveListenerConsent,
  readStoredAnswer,
  storeAnswer,
  makeElicit,
  findPackagedSettings,
  describeUiSettings,
  CONSENT_MESSAGE,
  ENABLE_NOTE,
  type ConsentDeps,
  type ElicitAnswer,
  type ElicitServer,
} from "../src/services/input-consent.js";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "logos-mcp-consent-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function deps(overrides: Partial<ConsentDeps> = {}) {
  const writes: Array<"on" | "off"> = [];
  let elicitCalls = 0;
  let stored: "on" | "off" | null = null;
  const d: ConsentDeps = {
    setting: "ask",
    settingsPath: "settings.json",
    platform: "win32",
    elicit: async () => {
      elicitCalls++;
      return "yes";
    },
    read: () => stored,
    write: (_path, answer) => {
      writes.push(answer);
      stored = answer;
    },
    ...overrides,
  };
  return { d, writes, elicitCalls: () => elicitCalls, setStored: (v: "on" | "off" | null) => (stored = v) };
}

describe("resolveListenerConsent", () => {
  it("lets LOGOS_INPUT_LISTENER on/off win over a stored answer", async () => {
    const on = deps({ setting: "on" });
    on.setStored("off");
    expect(await resolveListenerConsent(on.d)).toEqual({ listener: true, source: "env" });
    const off = deps({ setting: "off" });
    off.setStored("on");
    expect(await resolveListenerConsent(off.d)).toEqual({ listener: false, source: "env" });
  });

  it("uses a stored answer with ask, without prompting", async () => {
    const t = deps();
    t.setStored("on");
    expect(await resolveListenerConsent(t.d)).toEqual({ listener: true, source: "stored" });
    expect(t.elicitCalls()).toBe(0);
  });

  it("asks once and stores yes as on, no as off", async () => {
    const yes = deps();
    expect(await resolveListenerConsent(yes.d)).toEqual({ listener: true, source: "prompt" });
    expect(yes.writes).toEqual(["on"]);
    const no = deps({ elicit: async () => "no" });
    expect(await resolveListenerConsent(no.d)).toEqual({ listener: false, source: "prompt" });
    expect(no.writes).toEqual(["off"]);
  });

  it("falls back and stores nothing when the client can't ask", async () => {
    const t = deps({ elicit: async () => "unsupported" });
    expect(await resolveListenerConsent(t.d)).toEqual({ listener: false, source: "fallback", note: ENABLE_NOTE });
    expect(t.writes).toEqual([]);
  });

  it("falls back, stores nothing and asks again next time when nobody answers", async () => {
    let calls = 0;
    const t = deps({
      elicit: async () => {
        calls++;
        return "no_answer";
      },
    });
    expect(await resolveListenerConsent(t.d)).toEqual({ listener: false, source: "fallback" });
    await resolveListenerConsent(t.d);
    expect(calls).toBe(2);
    expect(t.writes).toEqual([]);
  });

  it("shows one prompt to two copies that start while it is open, and stores once", async () => {
    let answer!: (a: ElicitAnswer) => void;
    let calls = 0;
    const t = deps({
      elicit: () => {
        calls++;
        return new Promise<ElicitAnswer>((resolve) => (answer = resolve));
      },
    });
    const first = resolveListenerConsent(t.d);
    const second = resolveListenerConsent(t.d);
    answer("yes");
    expect(await first).toEqual({ listener: true, source: "prompt" });
    expect(await second).toEqual({ listener: true, source: "prompt" });
    expect(calls).toBe(1);
    expect(t.writes).toEqual(["on"]);
  });

  it("never prompts off Windows", async () => {
    const t = deps({ platform: "darwin" });
    expect(await resolveListenerConsent(t.d)).toEqual({ listener: false, source: "fallback" });
    expect(t.elicitCalls()).toBe(0);
  });

  it("still uses the answer for this word study when saving it fails, says so in a note, and asks again next time", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let calls = 0;
      const t = deps({
        settingsPath: "S/settings.json",
        elicit: async () => {
          calls++;
          return "yes";
        },
        write: () => {
          throw new Error("EACCES: permission denied");
        },
      });
      expect(await resolveListenerConsent(t.d)).toEqual({
        listener: true,
        source: "prompt",
        note: "could not save your answer to S/settings.json: EACCES: permission denied; you will be asked again next time",
      });
      await resolveListenerConsent(t.d);
      expect(calls).toBe(2);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("EACCES: permission denied"));
    } finally {
      log.mockRestore();
    }
  });

  it("gives the save-failure note to both copies that share a prompt", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let answer!: (a: ElicitAnswer) => void;
      const t = deps({
        elicit: () => new Promise<ElicitAnswer>((resolve) => (answer = resolve)),
        write: () => {
          throw new Error("disk full");
        },
      });
      const first = resolveListenerConsent(t.d);
      const second = resolveListenerConsent(t.d);
      answer("no");
      for (const r of [await first, await second]) {
        expect(r).toMatchObject({ listener: false, source: "prompt" });
        expect(r.note).toContain("disk full");
      }
    } finally {
      log.mockRestore();
    }
  });

  it("treats a rejected prompt as no answer and asks again next time", async () => {
    let calls = 0;
    const t = deps({
      elicit: async () => {
        calls++;
        throw new Error("transport closed");
      },
    });
    expect(await resolveListenerConsent(t.d)).toEqual({ listener: false, source: "fallback" });
    await resolveListenerConsent(t.d);
    expect(calls).toBe(2);
    expect(t.writes).toEqual([]);
  });
});

describe("stored answer", () => {
  it("round-trips through settings.json, keeping other keys", () => {
    const dir = tempDir();
    const path = join(dir, "logos-mcp", "settings.json");
    expect(readStoredAnswer(path)).toBeNull();
    mkdirSync(join(dir, "logos-mcp"), { recursive: true });
    writeFileSync(path, JSON.stringify({ other: 1 }));
    storeAnswer(path, "on");
    expect(readStoredAnswer(path)).toBe("on");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ other: 1, inputListener: "on" });
  });

  it("creates the folder and ignores a malformed file", () => {
    const dir = tempDir();
    const path = join(dir, "new", "settings.json");
    storeAnswer(path, "off");
    expect(readStoredAnswer(path)).toBe("off");
    writeFileSync(path, "{not json");
    expect(readStoredAnswer(path)).toBeNull();
  });

  it("replaces the file whole and leaves no temp file behind", () => {
    const dir = tempDir();
    const path = join(dir, "settings.json");
    storeAnswer(path, "on");
    storeAnswer(path, "off");
    expect(readdirSync(dir)).toEqual(["settings.json"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ inputListener: "off" });
  });

  it("throws and cleans up when the file can't be replaced", () => {
    const dir = tempDir();
    const path = join(dir, "settings.json");
    mkdirSync(path); // a folder where the file should be: the rename fails
    expect(() => storeAnswer(path, "on")).toThrow();
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });
});

describe("makeElicit", () => {
  function server(caps: { elicitation?: unknown } | undefined, reply: () => Promise<{ action: string; content?: Record<string, unknown> }>) {
    const seen: Array<{ message: string; timeout?: number }> = [];
    const s: ElicitServer = {
      getClientCapabilities: () => caps,
      elicitInput: async (params, options) => {
        seen.push({ message: params.message, timeout: options?.timeout });
        return reply();
      },
    };
    return { s, seen };
  }

  it("asks with the design's message and a 120 s timeout", async () => {
    const { s, seen } = server({ elicitation: {} }, async () => ({ action: "accept", content: { allow: "yes" } }));
    expect(await makeElicit(s)()).toBe("yes");
    expect(seen).toEqual([{ message: CONSENT_MESSAGE, timeout: 120_000 }]);
  });

  it("maps no, decline and dismiss", async () => {
    expect(await makeElicit(server({ elicitation: {} }, async () => ({ action: "accept", content: { allow: "no" } })).s)()).toBe("no");
    expect(await makeElicit(server({ elicitation: {} }, async () => ({ action: "decline" })).s)()).toBe("no");
    expect(await makeElicit(server({ elicitation: {} }, async () => ({ action: "cancel" })).s)()).toBe("no_answer");
  });

  it("is unsupported when the client can't elicit", async () => {
    expect(await makeElicit(server({}, async () => ({ action: "accept" })).s)()).toBe("unsupported");
    expect(
      await makeElicit(server({ elicitation: {} }, async () => {
        throw new Error("Client does not support form elicitation.");
      }).s)()
    ).toBe("unsupported");
  });

  it("is no_answer on a timeout", async () => {
    expect(
      await makeElicit(server({ elicitation: {} }, async () => {
        throw new Error("MCP error -32001: Request timed out");
      }).s)()
    ).toBe("no_answer");
  });
});

describe("CONSENT_MESSAGE", () => {
  it("says what is watched and what isn't", () => {
    expect(CONSENT_MESSAGE).toContain("never which key or where");
    expect(CONSENT_MESSAGE).toContain("only while it types a word");
    expect(CONSENT_MESSAGE.endsWith("Allow?")).toBe(true);
  });
});

describe("findPackagedSettings and describeUiSettings", () => {
  it("finds settings.json copies in packaged-app folders (W18)", () => {
    const local = tempDir();
    const inPackage = join(local, "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Local", "logos-mcp");
    mkdirSync(inPackage, { recursive: true });
    writeFileSync(join(inPackage, "settings.json"), "{}");
    mkdirSync(join(local, "Packages", "Other_app"), { recursive: true });
    expect(findPackagedSettings(local)).toEqual([join(inPackage, "settings.json")]);
    expect(findPackagedSettings(join(local, "missing"))).toEqual([]);
  });

  it("prints the focus mode, the listener mode and its source, and the settings paths", () => {
    const local = tempDir();
    const path = join(local, "logos-mcp", "settings.json");
    expect(describeUiSettings({ envValue: undefined, settingsPath: path, restoreFocus: true, platform: "win32", localAppData: local })).toEqual([
      "LOGOS_RESTORE_FOCUS: on (Windows: give focus back after opening a link)",
      "LOGOS_INPUT_LISTENER: ask (default)",
      `Settings file: ${path}`,
    ]);
    storeAnswer(path, "off");
    expect(describeUiSettings({ envValue: undefined, settingsPath: path, restoreFocus: false, platform: "win32", localAppData: local })[1]).toBe(
      "LOGOS_INPUT_LISTENER: off (stored answer)"
    );
    expect(describeUiSettings({ envValue: "on", settingsPath: path, restoreFocus: false, platform: "win32", localAppData: local })[1]).toBe(
      "LOGOS_INPUT_LISTENER: on (environment)"
    );
  });

  it("lists packaged copies, labelled", () => {
    const local = tempDir();
    const inPackage = join(local, "Packages", "Claude_x", "LocalCache", "Local", "logos-mcp");
    mkdirSync(inPackage, { recursive: true });
    writeFileSync(join(inPackage, "settings.json"), "{}");
    const lines = describeUiSettings({ settingsPath: join(local, "logos-mcp", "settings.json"), restoreFocus: true, platform: "win32", localAppData: local });
    expect(lines).toContain(`If the server runs inside a packaged app: ${join(inPackage, "settings.json")}`);
  });
});
