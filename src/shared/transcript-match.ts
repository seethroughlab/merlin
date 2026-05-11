/**
 * Transcript matching helpers — shared between main and renderer.
 *
 * Lives in src/shared/ so the renderer's background magic-word listener
 * can use the same matching logic as the main-process session without
 * pulling in any node-only imports. Pure functions; no side effects.
 */

/**
 * Lowercase + strip common end-of-utterance punctuation. Whisper
 * produces title case with trailing periods; Gemini-set magic words
 * arrive in whatever casing the model picked. Both sides go through
 * this normalization before comparison.
 */
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[.,!?;:]+/g, '').trim();
}

/**
 * Whole-word match for ONE phrase in a transcript, with normalization
 * (lowercase + strip punctuation) and regex-special escaping. Used by
 * the magic-word match, the play-phase end-word match, and the
 * register_effect_triggers local dispatcher.
 */
export function transcriptContains(transcript: string, phrase: string): boolean {
  const needle = normalizeForMatch(phrase);
  if (!needle) return false;
  const haystack = normalizeForMatch(transcript);
  if (!haystack) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(haystack);
}

/**
 * True when `transcript` contains `magicWord` as a whole word
 * (after normalization). Wrapper that accepts null/empty magicWord
 * (returns false) for the common "no spell yet" case.
 */
export function transcriptMatchesMagicWord(
  transcript: string,
  magicWord: string | null,
): boolean {
  if (!magicWord) return false;
  return transcriptContains(transcript, magicWord);
}

/**
 * Returns the first phrase from the list that appears in the transcript,
 * or null if none match. Order-preserving — useful when multiple triggers
 * could fire on the same utterance and you want the registered order to
 * win.
 */
export function transcriptMatchesAny(
  transcript: string,
  phrases: readonly string[],
): string | null {
  for (const phrase of phrases) {
    if (transcriptContains(transcript, phrase)) return phrase;
  }
  return null;
}
