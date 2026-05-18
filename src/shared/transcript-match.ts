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
 * Levenshtein edit distance. Iterative two-row implementation —
 * O(m*n) time, O(min(m,n)) space. Used for fuzzy magic-word matching
 * where Whisper mishears like "PEACH" → "Peace" / "each" / "perch"
 * should still cast.
 */
function editDistance(a: string, a2: string): number {
  if (a === a2) return 0;
  if (!a.length) return a2.length;
  if (!a2.length) return a.length;
  let prev = new Array(a2.length + 1);
  let curr = new Array(a2.length + 1);
  for (let j = 0; j <= a2.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= a2.length; j++) {
      const cost = a[i - 1] === a2[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // deletion
        curr[j - 1] + 1,    // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[a2.length];
}

/**
 * Edit-distance threshold scaled to the magic word's length. Below ~5
 * chars we require an exact match (the false-positive risk from
 * 1-edit on "peach" → "each" → "leach" → "reach" is too high relative
 * to how often we'd actually need it). At 5+ chars we allow 1 edit;
 * at 9+ chars we allow 2. Tuned for typical magic words like PEACH,
 * INCINERATE, ILLUMINATE, etc.
 */
function magicWordEditBudget(length: number): number {
  if (length < 5) return 0;
  if (length < 9) return 1;
  return 2;
}

/**
 * True when `transcript` contains `magicWord` as a whole word
 * (after normalization), OR contains a word within edit-distance
 * tolerance of the magic word. Tolerant of Whisper mishears like
 * "PEACH" → "Peace" / "PERCH" / "each" that exact matching would
 * miss. Wrapper that accepts null/empty magicWord (returns false)
 * for the common "no spell yet" case.
 */
export function transcriptMatchesMagicWord(
  transcript: string,
  magicWord: string | null,
): boolean {
  if (!magicWord) return false;
  if (transcriptContains(transcript, magicWord)) return true;
  // Fall back to fuzzy: check every whole-word in the transcript
  // against the magic word. Short magic words (< 5 chars) use a
  // budget of 0 (exact only) — see magicWordEditBudget.
  const needle = magicWord.toLowerCase().replace(/[.,!?;:]+/g, '').trim();
  if (!needle) return false;
  const budget = magicWordEditBudget(needle.length);
  if (budget === 0) return false;
  const haystack = transcript.toLowerCase().replace(/[.,!?;:]+/g, '').trim();
  const words = haystack.split(/\s+/).filter(w => w.length > 0);
  for (const word of words) {
    // Only allow fuzzy match for candidate words NOT LONGER than the
    // magic word. Whisper's common errors are character drops and
    // substitutions, not insertions — so "peach" → "each" / "peace"
    // should match, but real derived words like "incinerated" (11)
    // shouldn't fuzzy-match "incinerate" (10). This is the cheapest
    // way to keep "incinerator" / "incinerated" / "preacher" out.
    if (word.length > needle.length) continue;
    if (editDistance(word, needle) <= budget) return true;
  }
  return false;
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
