/**
 * SpellState Reducer
 *
 * Functions for creating, updating, and validating SpellState.
 */

import type {
  SpellState,
  SpellIntent,
  SpellElement,
  CastingOrigin,
  SpellTone,
} from '../../shared/types';

// Valid enum values for validation
const VALID_INTENTS: SpellIntent[] = [
  'confidence',
  'calm',
  'protection',
  'clarity',
  'creativity',
  'transformation',
  'release',
  'focus',
  'joy',
  'wonder',
];

const VALID_ELEMENTS: SpellElement[] = [
  'fire',
  'water',
  'air',
  'earth',
  'light',
  'shadow',
  'crystal',
  'storm',
  'flora',
  'cosmic',
];

const VALID_ORIGINS: CastingOrigin[] = ['hands', 'heart', 'eyes', 'whole_body', 'wand'];

const VALID_TONES: SpellTone[] = ['gentle', 'playful', 'mysterious', 'heroic', 'calm', 'wild'];

/**
 * Create the initial empty spell state
 */
export function createInitialSpellState(): SpellState {
  return {
    intent: null,
    element: null,
    tone: null,
    energy: 0.3,
    complexity: 0.2,
    castingOrigin: null,
    visualArchetype: null,
    palette: null,
    magicWord: null,
    confidence: 0,
  };
}

/**
 * Clamp a number to the 0-1 range
 */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Validate an intent value
 */
function validateIntent(value: unknown): SpellIntent | null {
  if (typeof value === 'string' && VALID_INTENTS.includes(value as SpellIntent)) {
    return value as SpellIntent;
  }
  return null;
}

/**
 * Validate an element value
 */
function validateElement(value: unknown): SpellElement | null {
  if (typeof value === 'string' && VALID_ELEMENTS.includes(value as SpellElement)) {
    return value as SpellElement;
  }
  return null;
}

/**
 * Validate a casting origin value
 */
function validateOrigin(value: unknown): CastingOrigin | null {
  if (typeof value === 'string' && VALID_ORIGINS.includes(value as CastingOrigin)) {
    return value as CastingOrigin;
  }
  return null;
}

/**
 * Validate a tone value
 */
function validateTone(value: unknown): SpellTone | null {
  if (typeof value === 'string' && VALID_TONES.includes(value as SpellTone)) {
    return value as SpellTone;
  }
  return null;
}

/**
 * Merge a partial update into the current spell state
 *
 * Rules:
 * - Numeric values are clamped to 0-1
 * - Invalid enum values are rejected (current value preserved)
 * - Null/undefined in update preserves current value
 * - Confidence increases when new values agree with existing
 */
export function mergeSpellUpdate(
  current: SpellState,
  update: Partial<SpellState>
): SpellState {
  const merged = { ...current };

  // Handle intent
  if (update.intent !== undefined) {
    const validated = validateIntent(update.intent);
    if (validated !== null) {
      // Increase confidence if intent matches existing
      if (current.intent === validated) {
        merged.confidence = clamp01(current.confidence + 0.1);
      }
      merged.intent = validated;
    }
  }

  // Handle element
  if (update.element !== undefined) {
    const validated = validateElement(update.element);
    if (validated !== null) {
      // Increase confidence if element matches existing
      if (current.element === validated) {
        merged.confidence = clamp01(current.confidence + 0.1);
      }
      merged.element = validated;
    }
  }

  // Handle tone
  if (update.tone !== undefined) {
    const validated = validateTone(update.tone);
    if (validated !== null) {
      merged.tone = validated;
    }
  }

  // Handle casting origin
  if (update.castingOrigin !== undefined) {
    const validated = validateOrigin(update.castingOrigin);
    if (validated !== null) {
      merged.castingOrigin = validated;
    }
  }

  // Handle numeric values
  if (typeof update.energy === 'number') {
    merged.energy = clamp01(update.energy);
  }

  if (typeof update.complexity === 'number') {
    merged.complexity = clamp01(update.complexity);
  }

  if (typeof update.confidence === 'number') {
    merged.confidence = clamp01(update.confidence);
  }

  // Handle string values
  if (typeof update.visualArchetype === 'string') {
    merged.visualArchetype = update.visualArchetype;
  }

  if (typeof update.palette === 'string') {
    merged.palette = update.palette;
  }

  if (typeof update.magicWord === 'string') {
    merged.magicWord = update.magicWord;
  }

  return merged;
}

/**
 * Get the default casting origin for a given intent
 */
export function defaultOriginForIntent(intent: SpellIntent): CastingOrigin {
  switch (intent) {
    case 'creativity':
    case 'transformation':
    case 'focus':
    case 'confidence':
      return 'hands';
    case 'calm':
    case 'release':
    case 'joy':
      return 'heart';
    case 'clarity':
    case 'wonder':
      return 'eyes';
    case 'protection':
      return 'whole_body';
  }
}

/**
 * Check if the spell state is complete enough for casting
 */
export function isSpellReady(spell: SpellState): boolean {
  return (
    spell.intent !== null &&
    spell.element !== null &&
    spell.castingOrigin !== null &&
    spell.magicWord !== null &&
    spell.confidence >= 0.5
  );
}

