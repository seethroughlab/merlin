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
  // Particle program types
  SpellVisualMode,
  ParticleSpellArchetype,
  ShaderZoneName,
  ZoneParams,
  CastEnvelope,
  SpellPalette,
  ParticleSpellProgram,
} from './types';

export { ZONE_NAME_TO_TD } from './types';

// Spell state utilities
export {
  createInitialSpellState,
  mergeSpellUpdate,
  defaultOriginForIntent,
  suggestElementForIntent,
  suggestToneForIntent,
  isSpellReady,
  paletteForElement,
} from './spell-state';

// Prompts (for reference/testing)
export { MERLIN_SYSTEM_PROMPT, MERLIN_TOOLS, getToolsForPhase } from './prompts';

// Particle program generation
export {
  createBuildupProgram,
  createReleaseProgram,
  createIdleProgram,
  selectArchetype,
  getArchetypeConfig,
  getPaletteForElement,
  getCastDuration,
  BUILDUP_ENERGY_MAX,
  RELEASE_ENERGY_PEAK,
  RELEASE_ENERGY_FLOOR,
  DEFAULT_CAST_ENVELOPE,
  CASTING_LANDMARKS,
} from './particle-program';
