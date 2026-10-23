import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { LOGOS_RESTORE_FOCUS, SETTINGS_PATH, parseListenerSetting, type ListenerSetting } from "../config.js";

// Consent for the input listener used while typing into Logos
// (withdrawn copy design §3.9, in history at 16da723). LOGOS_INPUT_LISTENER
// on/off always wins; with "ask", a stored answer is used, otherwise the user
// is asked once through MCP elicitation (Windows only). No tool parameter can
// turn the listener on.

export const CONSENT_MESSAGE =
  "Logos MCP can watch for your mouse and keyboard while it types a word into Logos, so it can stop the instant you start using the PC. It only notices that input happened (never which key or where), only while it types a word, and removes the watcher afterwards. Without it, word study still stops when you move the mouse or switch windows, but up to a couple of seconds later, and typing alone isn't noticed. Allow?";

export const ENABLE_NOTE = "set LOGOS_INPUT_LISTENER=on to enable instant takeover detection";

export type ElicitAnswer = "yes" | "no" | "unsupported" | "no_answer";

export interface ConsentDecision {
  listener: boolean;
  source: "env" | "stored" | "prompt" | "fallback";
  /** For the tool's result, e.g. how to turn the listener on. */
  note?: string;
}

export interface ConsentDeps {
  setting: ListenerSetting;
  settingsPath: string;
  platform: NodeJS.Platform;
  elicit(): Promise<ElicitAnswer>;
  read(path: string): "on" | "off" | null;
  write(path: string, answer: "on" | "off"): void;
}

interface Settled {
  answer: ElicitAnswer;
  /** Why the answer could not be saved, when it couldn't. */
  saveError?: string;
}

let pending: Promise<Settled> | null = null;

/**
 * Decides whether this run may use the input listener. A prompt that is
 * already open is shared, so two runs starting together see one prompt and
 * the answer is stored once; the shared prompt is cleared once it settles, so
 * a prompt nobody answered is asked again next time. When the answer can't be
 * saved it still applies to this run, and the decision carries a note saying
 * so (it is also logged to stderr).
 *
 * @param deps - Setting, storage and the elicitation call.
 * @returns The decision and where it came from.
 */
export async function resolveListenerConsent(deps: ConsentDeps): Promise<ConsentDecision> {
  if (deps.platform !== "win32") return { listener: false, source: "fallback" };
  if (deps.setting === "on") return { listener: true, source: "env" };
  if (deps.setting === "off") return { listener: false, source: "env" };
  const stored = deps.read(deps.settingsPath);
  if (stored) return { listener: stored === "on", source: "stored" };

  if (!pending) {
    pending = deps
      .elicit()
      .catch((): ElicitAnswer => "no_answer")
      .then((answer): Settled => {
        if (answer !== "yes" && answer !== "no") return { answer };
        try {
          deps.write(deps.settingsPath, answer === "yes" ? "on" : "off");
          return { answer };
        } catch (e) {
          // The answer still applies to this run; it is asked again next time.
          const message = e instanceof Error ? e.message : String(e);
          // stderr: stdout carries the MCP protocol.
          console.error(`logos-mcp: could not save the input-listener answer to ${deps.settingsPath}: ${message}`);
          return { answer, saveError: message };
        }
      })
      .finally(() => {
        pending = null;
      });
  }
  const { answer, saveError } = await pending;
  const note = saveError
    ? `could not save your answer to ${deps.settingsPath}: ${saveError}; you will be asked again next time`
    : undefined;
  if (answer === "yes") return { listener: true, source: "prompt", ...(note && { note }) };
  if (answer === "no") return { listener: false, source: "prompt", ...(note && { note }) };
  if (answer === "unsupported") return { listener: false, source: "fallback", note: ENABLE_NOTE };
  return { listener: false, source: "fallback" };
}

/**
 * The stored answer in settings.json ({"inputListener": "on" | "off"}).
 *
 * @param path - settings.json.
 * @returns "on", "off", or null when missing or unreadable.
 */
export function readStoredAnswer(path: string): "on" | "off" | null {
  try {
    const value = (JSON.parse(readFileSync(path, "utf8")) as { inputListener?: unknown }).inputListener;
    return value === "on" || value === "off" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Stores the answer, keeping any other keys in settings.json. Writes a temp
 * file beside it and renames it over the old one, so a reader (or a second
 * server process) sees the old file or the new one, never half of one. Two
 * processes answering at once: the last rename wins.
 *
 * @param path - settings.json.
 * @param answer - "on" or "off".
 * @throws When the folder or file can't be written (the temp file is removed).
 */
export function storeAnswer(path: string, answer: "on" | "off"): void {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // Missing or corrupt: start fresh (a corrupt file is replaced, its other keys are lost).
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ ...data, inputListener: answer }, null, 2)}\n`, "utf8");
    renameSync(temp, path);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

/** The parts of the SDK's Server that elicitation needs. */
export interface ElicitServer {
  getClientCapabilities(): { elicitation?: unknown } | undefined;
  elicitInput(
    params: { message: string; requestedSchema: Record<string, unknown> },
    options?: { timeout?: number }
  ): Promise<{ action: string; content?: Record<string, unknown> }>;
}

/**
 * The elicitation call for `resolveListenerConsent`.
 *
 * @param server - `McpServer.server`.
 * @param timeoutMs - How long to wait for an answer; defaults to 120 s.
 * @returns A function that asks and maps the reply.
 */
export function makeElicit(server: ElicitServer, timeoutMs = 120_000): () => Promise<ElicitAnswer> {
  return async () => {
    if (!server.getClientCapabilities()?.elicitation) return "unsupported";
    try {
      const result = await server.elicitInput(
        {
          message: CONSENT_MESSAGE,
          requestedSchema: {
            type: "object",
            properties: {
              allow: { type: "string", title: "Watch for my input while Logos MCP types", enum: ["yes", "no"] },
            },
            required: ["allow"],
          },
        },
        { timeout: timeoutMs }
      );
      if (result.action === "accept") return result.content?.allow === "yes" ? "yes" : "no";
      if (result.action === "decline") return "no";
      return "no_answer";
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return /does not support/i.test(message) ? "unsupported" : "no_answer";
    }
  };
}

/**
 * settings.json copies inside packaged apps' private folders. Writes under
 * %LOCALAPPDATA% from an MSIX-packaged host land there (W18).
 *
 * @param localAppData - %LOCALAPPDATA%.
 * @returns Existing paths.
 */
export function findPackagedSettings(localAppData: string): string[] {
  const packages = join(localAppData, "Packages");
  let names: string[];
  try {
    names = readdirSync(packages);
  } catch {
    return [];
  }
  return names
    .map((name) => join(packages, name, "LocalCache", "Local", "logos-mcp", "settings.json"))
    .filter((path) => existsSync(path));
}

/**
 * Lines for diagnose: focus restore, the listener mode and where it came
 * from, the settings file, and packaged-app copies of it.
 *
 * @param options - Defaults to the running server's settings.
 * @returns Plain lines.
 */
export function describeUiSettings(
  options: { envValue?: string; settingsPath?: string; restoreFocus?: boolean; platform?: NodeJS.Platform; localAppData?: string } = {}
): string[] {
  const envValue = "envValue" in options ? options.envValue : process.env.LOGOS_INPUT_LISTENER;
  const settingsPath = options.settingsPath ?? SETTINGS_PATH;
  const restoreFocus = options.restoreFocus ?? LOGOS_RESTORE_FOCUS;
  const platform = options.platform ?? process.platform;
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA ?? "";

  // Same precedence as resolveListenerConsent: on/off from the environment,
  // then a stored answer, otherwise ask.
  const fromEnv = parseListenerSetting(envValue);
  const stored = readStoredAnswer(settingsPath);
  const listener =
    fromEnv !== "ask" ? `${fromEnv} (environment)` : stored ? `${stored} (stored answer)` : "ask (default)";

  const lines = [
    `LOGOS_RESTORE_FOCUS: ${restoreFocus ? "on" : "off"} (Windows: give focus back after opening a link)`,
    `LOGOS_INPUT_LISTENER: ${listener}`,
    `Settings file: ${settingsPath}`,
  ];
  if (platform === "win32" && localAppData) {
    for (const path of findPackagedSettings(localAppData)) {
      lines.push(`If the server runs inside a packaged app: ${path}`);
    }
  }
  return lines;
}
