import { DISPATCHED_NOTE, uiFollowUpHint } from "./tool-text.js";
import type { LinkStyle } from "../config.js";
import type { WordStudyResult } from "../services/word-study.js";

// Formatting for open_word_study (design 2026-10-18). Handlers only format.

/**
 * Whether open_word_study can type the word: Windows, and the current link
 * style (the legacy link carries the word itself).
 *
 * @param platform - Platform to decide for.
 * @param style - The configured link style.
 * @returns True when the word can be typed into Logos.
 */
export function wordStudyTypingSupported(platform: NodeJS.Platform, style: LinkStyle): boolean {
  return platform === "win32" && style === "current";
}

/**
 * The reply where typing isn't supported: current Logos opened the study
 * empty, so the user types the word.
 *
 * @param word - The word asked for.
 * @returns The reply text.
 */
export function wordStudyEmptyText(word: string): string {
  return `Opened Bible Word Study. Logos does not accept the word via link, and typing into Logos is only supported on Windows — ask the user to type "${word}" into it (use \`g:\` / \`h:\` for Greek/Hebrew, e.g. \`g:agape\`).`;
}

function notes(r: WordStudyResult): string {
  return r.warnings.length > 0 ? `\n\nNotes:\n${r.warnings.map((w) => `- ${w}`).join("\n")}` : "";
}

/**
 * The reply for a finished or interrupted run.
 *
 * @param r - The run's result.
 * @returns The reply text.
 */
export function wordStudyResultText(r: WordStudyResult): string {
  const typed = `"${r.word}"`;
  switch (r.status) {
    case "ran":
      return `Ran Bible Word Study for ${typed}: typed the word and pressed Enter, and Logos recorded the study (${r.recorded}). ${DISPATCHED_NOTE}${uiFollowUpHint()}${notes(r)}`;
    case "different":
      return `Typed ${typed} into Bible Word Study and pressed Enter, but Logos recorded "${r.recorded}" instead. Check what the study shows.${notes(r)}`;
    case "unconfirmed":
      return `Typed ${typed} into Bible Word Study and pressed Enter, but Logos's history shows no matching study, so it can't be confirmed that it ran. Check the Logos window.${notes(r)}`;
    case "unavailable":
      return `Typed ${typed} into Bible Word Study and pressed Enter. Logos's history could not be read, so it can't be confirmed that the study ran.${uiFollowUpHint()}${notes(r)}`;
    case "interrupted": {
      const progress: Record<WordStudyResult["stage"], string> = {
        none: "Nothing was opened.",
        launching: "The link was sent, so a Bible Word Study may be open; nothing was typed.",
        opened: "An empty Bible Word Study is open; nothing was typed.",
        typing: `Part or all of ${typed} may be in its word box; Enter was not pressed.`,
        typed: `${typed} was typed but Enter was not pressed.`,
        entering: "Enter may have been pressed, so the study may have run.",
        entered: "Enter was pressed, so the study may have run.",
      };
      return `Stopped: ${r.reason}. ${progress[r.stage]}${notes(r)}`;
    }
  }
}

/**
 * The error reply for a run that failed before typing: the message, then one
 * "Also:" line per warning.
 *
 * @param e - A WordStudyError, or anything with its message and warnings.
 * @returns The reply text.
 */
export function formatWordStudyError(e: { message: string; warnings: readonly string[] }): string {
  return [e.message, ...e.warnings.map((w) => `Also: ${w}`)].join("\n");
}
