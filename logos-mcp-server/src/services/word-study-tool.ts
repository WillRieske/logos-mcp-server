import type { ConsentDecision } from "./input-consent.js";
import type { WordStudyRequest, WordStudyResult } from "./word-study.js";

// open_word_study's steps after input validation (design 2026-10-18): consent
// first, outside the UI lock, so a prompt left open blocks no other tool;
// then the run, which takes the lock; then the consent note in the reply.

/** The steps wordStudyWithConsent runs; tests pass fakes. */
export interface WordStudyToolDeps {
  consent(): Promise<ConsentDecision>;
  run(request: WordStudyRequest): Promise<WordStudyResult>;
}

/**
 * Resolves listener consent, then runs the word study with it.
 *
 * @param input - The request without the consent flag.
 * @param deps - The consent resolver and the (locked) run.
 * @returns The run's result, with the consent note (if any) in its warnings.
 */
export async function wordStudyWithConsent(
  input: Omit<WordStudyRequest, "listenerConsent">,
  deps: WordStudyToolDeps
): Promise<WordStudyResult> {
  const consent = await deps.consent();
  const result = await deps.run({ ...input, listenerConsent: consent.listener });
  return consent.note ? { ...result, warnings: [...result.warnings, consent.note] } : result;
}
