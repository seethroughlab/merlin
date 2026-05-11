import { describe, it, expect } from 'vitest';
import { transcriptMatchesMagicWord, transcriptContains, transcriptMatchesAny } from './spell-state';

describe('transcriptMatchesMagicWord', () => {
  it('matches case-insensitively after stripping trailing punctuation', () => {
    // The classic Whisper-output / Gemini-stored mismatch:
    // Whisper produces 'Incinerate.' (title case + period), Gemini
    // registered the word as 'INCINERATE' (uppercase).
    expect(transcriptMatchesMagicWord('Incinerate.', 'INCINERATE')).toBe(true);
  });

  it('matches the magic word inside a longer utterance', () => {
    // Natural speech: the participant says the word in a sentence.
    expect(transcriptMatchesMagicWord("I'll say it: incinerate!", 'incinerate')).toBe(true);
    expect(transcriptMatchesMagicWord('Now, incinerate!', 'incinerate')).toBe(true);
  });

  it('respects word boundaries — does not match a longer word containing the needle', () => {
    expect(transcriptMatchesMagicWord('incinerated', 'incinerate')).toBe(false);
    expect(transcriptMatchesMagicWord('incinerator', 'incinerate')).toBe(false);
  });

  it('respects word boundaries — does not match a substring of an unrelated word', () => {
    // Pathological case: the magicWord substring appears inside a
    // word that has nothing to do with the spell.
    expect(transcriptMatchesMagicWord('disincentive', 'incentive')).toBe(false);
  });

  it('returns false when magicWord is null (no spell registered yet)', () => {
    expect(transcriptMatchesMagicWord('whatever I say', null)).toBe(false);
  });

  it('returns false when magicWord is empty', () => {
    expect(transcriptMatchesMagicWord('whatever', '')).toBe(false);
  });

  it('returns false when transcript is empty', () => {
    expect(transcriptMatchesMagicWord('', 'incinerate')).toBe(false);
  });

  it('escapes regex special characters in the magic word', () => {
    // Defensive: Gemini might pick a magic word with punctuation
    // ('go!', 'fire-storm', 'now?'). The regex must not crash and
    // must still match correctly after both sides are normalized.
    expect(transcriptMatchesMagicWord('GO!', 'go!')).toBe(true);
    expect(transcriptMatchesMagicWord('say go now!', 'go!')).toBe(true);
  });

  it('handles multi-word magic phrases', () => {
    // Less common but possible — Gemini could pick "let go" or "be free".
    expect(transcriptMatchesMagicWord("Now I'll let go!", 'let go')).toBe(true);
    expect(transcriptMatchesMagicWord('alphabet government', 'let go')).toBe(false);
  });

  it('strips multiple punctuation marks together', () => {
    expect(transcriptMatchesMagicWord('Incinerate?!', 'INCINERATE')).toBe(true);
    expect(transcriptMatchesMagicWord('incinerate...', 'incinerate')).toBe(true);
  });

  it('trims leading and trailing whitespace before matching', () => {
    expect(transcriptMatchesMagicWord('   incinerate   ', 'incinerate')).toBe(true);
    expect(transcriptMatchesMagicWord('incinerate', '  incinerate  ')).toBe(true);
  });
});

describe('transcriptContains', () => {
  // Used by the end-word matcher and the effect-trigger local dispatcher.
  // Same normalization + word-boundary regex as transcriptMatchesMagicWord
  // but with no null-handling (caller decides).

  it('matches case-insensitively after stripping punctuation', () => {
    expect(transcriptContains('Farewell.', 'farewell')).toBe(true);
    expect(transcriptContains('  rise!  ', 'rise')).toBe(true);
  });

  it('respects word boundaries', () => {
    expect(transcriptContains('uprising', 'rise')).toBe(false);
    expect(transcriptContains('riser', 'rise')).toBe(false);
  });

  it('returns false on empty inputs', () => {
    expect(transcriptContains('', 'farewell')).toBe(false);
    expect(transcriptContains('say farewell', '')).toBe(false);
  });

  it('handles multi-word phrases', () => {
    expect(transcriptContains("I'll say it: let go", 'let go')).toBe(true);
    expect(transcriptContains('alphabet government', 'let go')).toBe(false);
  });
});

describe('transcriptMatchesAny', () => {
  // Order-preserving first-match — used by the effect-trigger dispatcher
  // so the registration order in register_effect_triggers determines
  // which trigger wins when an utterance contains more than one.

  it('returns the first matching phrase in order', () => {
    expect(transcriptMatchesAny('rise and shimmer!', ['rise', 'shimmer'])).toBe('rise');
    expect(transcriptMatchesAny('rise and shimmer!', ['shimmer', 'rise'])).toBe('shimmer');
  });

  it('returns null when no phrase matches', () => {
    expect(transcriptMatchesAny('nothing relevant here', ['rise', 'still'])).toBeNull();
  });

  it('returns null when the phrase list is empty', () => {
    expect(transcriptMatchesAny('anything', [])).toBeNull();
  });

  it('honors word boundaries (does not match substrings)', () => {
    expect(transcriptMatchesAny('riser', ['rise'])).toBeNull();
    expect(transcriptMatchesAny('arising', ['rise'])).toBeNull();
  });
});
