// What is typed into Bible Word Study's word box (design 2026-10-18).

/** Longest word typed; longer input is more likely a mistake than a word. */
export const MAX_WORD_CHARS = 64;

/**
 * Splits off the `g:` / `h:` prefix Logos reads as "Greek" / "Hebrew".
 * Logos then records a lemma, not the typed word.
 *
 * @param input - The word as typed.
 * @returns The language prefix when present (`lemma`), and the word without it.
 */
export function parseWordInput(input: string): { lemma: "g" | "h" | null; term: string } {
  const m = /^\s*([gh]):\s*(.*)$/i.exec(input);
  return m ? { lemma: m[1].toLowerCase() as "g" | "h", term: m[2].trim() } : { lemma: null, term: input.trim() };
}

/**
 * Checks and trims a word before it is typed. A newline would act as Enter and
 * a control character as a shortcut, so both are refused.
 *
 * @param input - The word as given to the tool.
 * @returns The trimmed word.
 * @throws Error naming the problem.
 */
export function validateWord(input: string): string {
  const word = input.trim();
  if (word === "") throw new Error("Give a word to study.");
  // eslint-disable-next-line no-control-regex
  if (/\p{Cc}/u.test(word) || word.includes(String.fromCharCode(0x2028)) || word.includes(String.fromCharCode(0x2029))) {
    throw new Error("The word contains a control character or line break.");
  }
  if (parseWordInput(word).lemma && parseWordInput(word).term === "") throw new Error("Give a word after the g: or h: prefix.");
  if ([...word].length > MAX_WORD_CHARS) throw new Error(`The word is longer than ${MAX_WORD_CHARS} characters.`);
  return word;
}
