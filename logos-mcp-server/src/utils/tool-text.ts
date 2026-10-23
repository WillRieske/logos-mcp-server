import type { HistoryConfirmation, HistoryVisit, KnowledgeEntry, LogosWindowState } from "../types.js";

// Window titles come from a compiled macOS helper or, on Windows, from
// PowerShell helpers. Elsewhere there is nothing to confirm with, so
// messages must not suggest get_logos_state.

/**
 * Whether window titles (and so confirming the UI) are available.
 *
 * @param platform - Platform to decide for; defaults to the running one.
 * @returns True on macOS and Windows.
 */
export function windowTitlesAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "win32";
}

/** Appended to every UI-dispatch result so the assistant knows nothing was returned. */
export const DISPATCHED_NOTE = "This only opens the Logos UI on the user's screen — no data is returned to you.";

/**
 * Follow-up suggestion for a UI-dispatch result.
 *
 * @param platform - Platform to decide for; defaults to the running one.
 * @returns A sentence with a leading space on macOS and Windows, otherwise an empty string.
 */
export function uiFollowUpHint(platform: NodeJS.Platform = process.platform): string {
  if (!windowTitlesAvailable(platform)) return "";
  return " Call get_logos_state to confirm what Logos is showing.";
}

/**
 * Text for `get_logos_state` when Logos is running.
 *
 * @param state - Window titles and (Windows) open tabs; null parts failed.
 * @param platform - Platform to decide for; defaults to the running one.
 * @returns A status message that reports what it has when one part failed.
 */
export function logosStateText(
  state: LogosWindowState,
  platform: NodeJS.Platform = process.platform
): string {
  if (!windowTitlesAvailable(platform)) {
    return "Logos is running. Window titles are not available on this platform.";
  }
  const titleLines =
    state.titles === null
      ? ["- (titles unavailable)"]
      : state.titles.length > 0
        ? state.titles.map((t) => `- ${t}`)
        : ["- (no named windows found)"];
  let out = `Logos is running. Window titles:\n${titleLines.join("\n")}`;
  if (platform === "win32") {
    const tabs = state.tabs === null ? "(tabs unavailable)" : state.tabs.length > 0 ? state.tabs.join(" | ") : "(none)";
    out += `\nOpen tabs: ${tabs}`;
  }
  return out;
}

/**
 * One line per knowledge-base entry, for asking which of several matches the
 * assistant means.
 *
 * @param matches - Ambiguous knowledge-base entries.
 * @returns A markdown bullet list.
 */
export function formatKnowledgeChoices(matches: KnowledgeEntry[]): string {
  return matches.map((m) => `- \`${m.id}\` — ${m.label}${m.kind ? ` (${m.kind})` : ""}`).join("\n");
}

// "PNTC Jn at John 5:14" for a resource; "Exegetical Guide (John 5:14)" for a
// guide, Factbook entry or search, whose subtitle is not always a place.
function visitName(visit: HistoryVisit): string {
  if (!visit.subtitle) return visit.title;
  return visit.kind === "Resource" ? `${visit.title} at ${visit.subtitle}` : `${visit.title} (${visit.subtitle})`;
}

/**
 * Reply for a link once Logos's history has been checked. Without a history
 * store the reply is the plain dispatch message used before PR 3.
 *
 * @param confirmation - The outcome from `waitForHistoryVisit`.
 * @param what - Names the target, e.g. "resource `LLS:29.48.20` at John 5:14".
 * @param platform - Defaults to the current platform.
 * @returns The reply text for the tool result.
 */
export function openConfirmationText(
  confirmation: HistoryConfirmation,
  what: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (confirmation.status === "confirmed") {
    return `Opened ${visitName(confirmation.visit)} in Logos. ${DISPATCHED_NOTE}`;
  }
  if (confirmation.status === "already_open") {
    return `Logos is already showing ${visitName(confirmation.visit)}. ${DISPATCHED_NOTE}`;
  }
  if (confirmation.status === "unconfirmed") {
    return `Sent ${what} to Logos, but Logos did not confirm opening it — Logos may be busy; try again once it responds.`;
  }
  return `Dispatched to Logos: ${what}. ${DISPATCHED_NOTE}${uiFollowUpHint(platform)}`;
}
