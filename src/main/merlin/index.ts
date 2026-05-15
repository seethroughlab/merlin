/**
 * Merlin Module - Public Exports
 *
 * The Merlin Mirror spell-casting experience.
 */

// Session
export { MerlinSession, createMerlinSession } from './session';
export type { MerlinSessionConfig, OnSpellUpdateCallback, OnPhaseChangeCallback, OnRequestAnalysisCallback } from './session';

// Types
export type {
  MerlinPhase,
  SpellIntent,
  SpellElement,
  CastingOrigin,
  SpellTone,
  SpellState,
  MerlinResponse,
  MerlinConversationMessage,
  MerlinUIUpdate,
  MerlinSessionInfo,
} from './types';

export type {
  MerlinSessionState,
  MerlinToolCall,
  MerlinPhaseConfig,
  ConversationMessage,
  BodySnapshot,
  FaceSnapshot,
} from './types';

export { ZONE_NAME_TO_TD } from './types';

// Spell state utilities
export {
  createInitialSpellState,
  mergeSpellUpdate,
  defaultOriginForIntent,
  isSpellReady,
} from './spell-state';

// Prompts (for reference/testing)
export { MERLIN_SYSTEM_PROMPT } from './system-prompts';
export { MERLIN_TOOLS } from './tool-definitions';
