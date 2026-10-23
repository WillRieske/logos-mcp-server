import { homedir } from "os";
import { join, dirname } from "path";
import { existsSync, readdirSync, statSync } from "fs";
import { fileURLToPath } from "url";

// Load .env for development (Node 20.12+; real env vars take precedence).
// MCP clients launch the server from an arbitrary cwd, so try the working
// directory, then the package root, then the repo root (where the README
// documents .env). First file found wins.
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
for (const envPath of [
  join(process.cwd(), ".env"),
  join(PACKAGE_ROOT, ".env"),
  join(PACKAGE_ROOT, "..", ".env"),
]) {
  try {
    process.loadEnvFile(envPath);
    break;
  } catch {
    // File absent or Node predates loadEnvFile — keep trying; env may
    // legitimately come from the MCP client config instead.
  }
}

// ─── Logos Data Paths ────────────────────────────────────────────────────────

const IS_WINDOWS = process.platform === "win32";

const LOCAL_APPDATA = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");

const LOGOS_ROOT = IS_WINDOWS
  ? join(LOCAL_APPDATA, "Logos")
  : join(homedir(), "Library", "Application Support", "Logos4");
const FALLBACK_PROFILE_ID = "a3wo155q.w14";

interface ProfileDir {
  name: string;
  mtimeMs: number;
}

function listProfiles(parent: string, suffix?: string): ProfileDir[] {
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() && (suffix === undefined || d.name.endsWith(suffix))
      )
      .map((d) => {
        const fullPath = join(parent, d.name);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(fullPath).mtimeMs;
        } catch {
          // Ignore stat failures and keep deterministic ordering.
        }
        return { name: d.name, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

// A Data/<id> dir is only useful if it actually contains the library catalog.
function hasCatalogMarker(profileName: string): boolean {
  try {
    return existsSync(
      join(LOGOS_ROOT, "Data", profileName, "LibraryCatalog", "catalog.db")
    );
  } catch {
    return false;
  }
}

function detectProfileId(): string {
  let documents = listProfiles(join(LOGOS_ROOT, "Documents"), ".w14");
  let data = listProfiles(join(LOGOS_ROOT, "Data"), ".w14");

  // Windows installs may not use the ".w14" suffix — when no matching dirs
  // exist at all, relax the filter to any directory.
  if (documents.length === 0 && data.length === 0) {
    documents = listProfiles(join(LOGOS_ROOT, "Documents"));
    data = listProfiles(join(LOGOS_ROOT, "Data"));
  }

  if (documents.length === 0 && data.length === 0) {
    return FALLBACK_PROFILE_ID;
  }

  // 1) Prefer a Data/<id> dir that actually contains LibraryCatalog/catalog.db
  const withMarker = data.filter((p) => hasCatalogMarker(p.name));
  if (withMarker.length > 0) {
    return withMarker[0].name;
  }

  // 2) Paired Documents/Data dirs
  const dataByName = new Set(data.map((p) => p.name));
  const paired = documents.filter((p) => dataByName.has(p.name));
  if (paired.length > 0) {
    return paired[0].name;
  }

  // 3) Newest-mtime dir
  return documents[0]?.name ?? data[0]?.name ?? FALLBACK_PROFILE_ID;
}

const PROFILE_ID = detectProfileId();

const LOGOS_BASE = join(LOGOS_ROOT, "Documents", PROFILE_ID);

export const LOGOS_DATA_DIR =
  process.env.LOGOS_DATA_DIR ?? LOGOS_BASE;

// Catalog DB lives under Data/ (not Documents/)
const LOGOS_CATALOG_BASE = join(LOGOS_ROOT, "Data", PROFILE_ID);

export const LOGOS_CATALOG_DIR =
  process.env.LOGOS_CATALOG_DIR ?? LOGOS_CATALOG_BASE;

export const DB_PATHS = {
  visualMarkup: join(LOGOS_DATA_DIR, "VisualMarkup", "visualmarkup.db"),
  favorites: join(LOGOS_DATA_DIR, "FavoritesManager", "favorites.db"),
  workflows: join(LOGOS_DATA_DIR, "Workflows", "Workflows.db"),
  readingLists: join(LOGOS_DATA_DIR, "ReadingLists", "ReadingLists.db"),
  shortcuts: join(LOGOS_DATA_DIR, "ShortcutsManager", "shortcuts.db"),
  guides: join(LOGOS_DATA_DIR, "Guides", "guides.db"),
  notes: join(LOGOS_DATA_DIR, "NotesToolManager", "notestool.db"),
  clippings: join(LOGOS_DATA_DIR, "Documents", "Clippings", "Clippings.db"),
  passageLists: join(LOGOS_DATA_DIR, "Documents", "PassageList", "PassageList.db"),
  readingPlans: join(LOGOS_DATA_DIR, "Documents", "ReadingPlan", "ReadingPlan.db"),
  catalog: join(LOGOS_CATALOG_DIR, "LibraryCatalog", "catalog.db"),
  // Name -> knowledge-base ID lookup (~110 MB; queries touch only small tables).
  autoComplete: join(LOGOS_CATALOG_DIR, "AutoComplete", "AutoComplete.db"),
  readingProgress: join(LOGOS_CATALOG_DIR, "ReadingProgressManager", "readingprogressmanager.db"),
  history: join(LOGOS_CATALOG_DIR, "HistoryManager", "history.db"),
} as const;

// DB_PATHS entries that only some Logos versions (or a Logos that has run at
// least once) have. diagnose reports them as not present instead of failing;
// their tools fall back or answer "not available". visualMarkup is absent on
// Logos 54 (highlights moved to notestool.db); AutoComplete.db is built on
// first run.
export const OPTIONAL_DB_NAMES: ReadonlySet<string> = new Set(["visualMarkup", "autoComplete", "readingPlans", "readingLists", "readingProgress", "history", "passageLists"]);

// ─── Biblia API ──────────────────────────────────────────────────────────────

export const BIBLIA_API_KEY = process.env.BIBLIA_API_KEY ?? "";
export const BIBLIA_API_BASE = "https://api.biblia.com/v1/bible";
export const DEFAULT_BIBLE = "LEB";

// ─── Logos URL Schemes ───────────────────────────────────────────────────────

// "current" = link formats verified on Logos 54 (design doc F1/F5/F6);
// "legacy"  = the logos4:/// query-string URLs used before, reported to work
// on macOS Logos 48. Whether Logos accepted a guide/Factbook link can't be
// detected, so this is an explicit setting.
export type LinkStyle = "current" | "legacy";
export const LOGOS_LINK_STYLE: LinkStyle =
  process.env.LOGOS_LINK_STYLE?.trim().toLowerCase() === "legacy" ? "legacy" : "current";

// Bible to open passages in when the catalog names none.
export const DEFAULT_BIBLE_RESOURCE_ID = "LLS:LEB";

// ─── UI Automation (focus restore, word-study typing) ───────────────────────

/**
 * Reads an on/off setting. `false`/`0`/`no`/`off` are off, `true`/`1`/`yes`/`on`
 * are on (any case); anything else, or unset, is `fallback`.
 */
export function parseFlag(value: string | undefined, fallback: boolean): boolean {
  const v = value?.trim().toLowerCase();
  if (!v) return fallback;
  if (["false", "0", "no", "off"].includes(v)) return false;
  if (["true", "1", "yes", "on"].includes(v)) return true;
  return fallback;
}

// Windows only: Logos brings itself to the front on every link the server
// opens; by default the server gives the foreground back (design §2).
export const LOGOS_RESTORE_FOCUS = parseFlag(process.env.LOGOS_RESTORE_FOCUS, true);

/** Whether open_word_study may watch for the user's input while it types (LOGOS_INPUT_LISTENER). */
export type ListenerSetting = "ask" | "on" | "off";

/** Reads LOGOS_INPUT_LISTENER; anything but "on"/"off" is "ask". */
export function parseListenerSetting(value: string | undefined): ListenerSetting {
  const v = value?.trim().toLowerCase();
  return v === "on" || v === "off" ? v : "ask";
}

export const LOGOS_INPUT_LISTENER = parseListenerSetting(process.env.LOGOS_INPUT_LISTENER);

// The input driver (open_word_study's typing). The first command also waits
// for PowerShell to start and compile; the UI Automation queries (tabs,
// focused control) run on Logos's UI thread: 0.5-2.4 s measured idle (2026-10-18).
export const DRIVER_LIMITS = {
  commandTimeoutMs: 5_000,
  initTimeoutMs: 15_000,
  uiaTimeoutMs: 15_000,
  closeGraceMs: 1_000,
  // How far the cursor may drift before word study counts it as the user's (takeover).
  cursorTolerancePx: 3,
  // Pauses inside the Windows driver's commands, sent with its init command.
  driverTiming: {
    keyStepMs: 40, // between a key's press and its release
    enterReleaseMs: 150, // after Enter, for Logos to act on it
    typeStepMs: 30, // between a typed character's press and release
    focusSettleMs: 200, // after SetForegroundWindow
  },
} as const;

export type DriverLimits = typeof DRIVER_LIMITS;

// The UI lock's defaults. The longest locked operation is word study
// (45 s limit; its own 60 s hold, WORD_STUDY_LIMITS).
export const UI_LOCK_LIMITS = {
  maxHoldMs: 60_000,
  settleMs: 2_000,
} as const;

// open_word_study's typing (design 2026-10-18). The time limit covers the
// driver start (up to 15 s), the new tab, typing and the history wait (8 s).
export const WORD_STUDY_LIMITS = {
  timeLimitMs: 45_000,
  // How long to wait for the new Bible Word Study tab, polled every tabPollMs.
  tabWaitMs: 8_000,
  tabPollMs: 300,
  // After the tab appears, for Logos to focus the word box.
  focusSettleMs: 500,
  lockMaxHoldMs: 60_000,
  lockSettleMs: 2_000,
} as const;

export type WordStudyLimits = typeof WORD_STUDY_LIMITS;

// The server's own folder: the consent answer (settings.json) and, on
// Windows, the helper cache. Inside an MSIX-packaged host (the Claude desktop
// app) Windows redirects writes here into the package's private copy; the
// server and its PowerShell children still see the same file (probe W18).
export const MCP_DATA_DIR = IS_WINDOWS
  ? join(LOCAL_APPDATA, "logos-mcp")
  : join(homedir(), "Library", "Application Support", "logos-mcp");
export const SETTINGS_PATH = join(MCP_DATA_DIR, "settings.json");

// ─── Window state ───────────────────────────────────────────────────────────

// Private per-user cache dir (not world-writable /tmp) so a local attacker
// can't pre-plant a malicious binary or symlink at a predictable path.
export const HELPER_CACHE_DIR = IS_WINDOWS
  ? join(MCP_DATA_DIR, "cache")
  : join(homedir(), "Library", "Caches", "logos-mcp");
export const WINDOW_HELPER_BIN = join(HELPER_CACHE_DIR, "logos-window-helper");
export const WINDOW_HELPER_SRC = join(HELPER_CACHE_DIR, "logos-window-helper.m");

// ─── Server Info ─────────────────────────────────────────────────────────────

export const SERVER_NAME = "logos-bible";
export const SERVER_VERSION = "1.0.0";
