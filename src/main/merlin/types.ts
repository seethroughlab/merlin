/**
 * Merlin Session Types
 *
 * Types for the Merlin Mirror spell-casting experience.
 */

import type { BodyLanguageAnalysis, MicroExpressionAnalysis } from '../../shared/types';

// Re-export shared types for convenience
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
} from '../../shared/types';

import type {
  MerlinPhase,
  SpellState,
  MerlinConversationMessage,
} from '../../shared/types';

/**
 * Body snapshot for history tracking
 */
export interface BodySnapshot {
  timestamp: number;
  openness: number;
  tension: number;
  engagement: number;
}

/**
 * Face snapshot for history tracking
 */
export interface FaceSnapshot {
  timestamp: number;
  valence: number;
  arousal: number;
  primaryEmotion: string;
}

/**
 * Full session state for the Merlin experience
 */
export interface MerlinSessionState {
  phase: MerlinPhase;
  turnCount: number;
  spell: SpellState;
  conversationSummary: string;
  bodyHistory: BodySnapshot[];
  faceHistory: FaceSnapshot[];
  castReady: boolean;
  castCompleted: boolean;
  lastUserInput: string;
  lastPosture: Partial<BodyLanguageAnalysis> | null;
  lastExpression: Partial<MicroExpressionAnalysis> | null;
  lastPerceptionTime: number;
}

/**
 * Tool call from Gemini
 */
export interface MerlinToolCall {
  name:
    | 'get_posture'
    | 'get_expression'
    | 'set_spell_profile'
    | 'prepare_casting'
    | 'set_zone_shader'
    | 'request_visual_feedback'
    | 'generate_sprite';
  args: Record<string, unknown>;
}

/**
 * Visual directive for TouchDesigner
 */
export interface MerlinVisualDirective {
  type: 'update_buildup' | 'trigger_effect' | 'set_scene';
  params: Record<string, unknown>;
}

/**
 * Parameters for set_spell_profile tool
 */
export interface SetSpellProfileParams {
  intent?: string;
  element?: string;
  tone?: string;
  energy?: number;
  castingOrigin?: string;
  visualArchetype?: string;
  palette?: string;
}

/**
 * Parameters for prepare_casting tool
 */
export interface PrepareCastingParams {
  magicWord: string;
  gestureHint: string;
}

/**
 * Parameters for get_posture tool
 */
export interface GetPostureParams {
  focus?: 'stance' | 'hands' | 'overall';
}

/**
 * Parameters for get_expression tool
 */
export interface GetExpressionParams {
  focus?: 'eyes' | 'mouth' | 'overall';
}

/**
 * Phase duration configuration
 */
export interface MerlinPhaseConfig {
  introTurns: number;
  discoveryTurns: number;
  formationTurns: number;
  castingTurns: number;
  outroTurns: number;
}

/**
 * Conversation message with perception context
 */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  bodySnapshot?: Partial<BodyLanguageAnalysis>;
  faceSnapshot?: Partial<MicroExpressionAnalysis>;
}

// ============ PARTICLE SPELL PROGRAM TYPES ============

/**
 * Visual mode for the particle system
 */
export type SpellVisualMode = 'idle' | 'buildup' | 'release';

/**
 * Supported particle spell archetypes
 */
export type ParticleSpellArchetype =
  | 'rising_embers'
  | 'breathing_aura_mist'
  | 'orbiting_stardust';

/**
 * Shader zone names (matches TD template system)
 */
export type ShaderZoneName = 'spawn' | 'force' | 'velmod' | 'size' | 'color';

/**
 * Zone name mapping to legacy TD names
 */
export const ZONE_NAME_TO_TD: Record<ShaderZoneName, string> = {
  spawn: 'spawn_behavior',
  force: 'force_field',
  velmod: 'velocity_modifier',
  size: 'size_over_life',
  color: 'color_over_life',
};

/**
 * Zone-specific particle parameters
 */
export interface ZoneParams {
  // Spawn parameters
  spawnRadius?: number;        // 0.1-0.5
  spawnRate?: number;          // 0.5-3.0 multiplier

  // Force parameters
  forceStrength?: number;      // 0-1
  forceDirection?: 'inward' | 'outward' | 'tangential' | 'upward';
  orbitSpeed?: number;         // 0-2
  turbulence?: number;         // 0-1

  // Velocity parameters
  velocityScale?: number;      // 0.5-3.0
  damping?: number;            // 0-1

  // Size parameters
  baseSize?: number;           // 0.01-0.15
  sizeVariation?: number;      // 0-1

  // Color parameters
  saturation?: number;         // 0-1
  brightness?: number;         // 0-1
  alphaFade?: number;          // 0-1
}

/**
 * Cast envelope timing (three-beat structure per PRD §8.3)
 */
export interface CastEnvelope {
  ignitionMs: number;    // sharp rise at casting origin (default: 400)
  projectionMs: number;  // peak burst projected outward (default: 1200)
  afterglowMs: number;   // decay back to calmer buildup (default: 2900)
  peakIntensity: number; // 0-1
}

/**
 * Color palette for a spell
 */
export interface SpellPalette {
  primary: string;    // hex color
  secondary: string;  // hex color
  accent: string;     // hex color
}

/**
 * Complete particle spell program sent to TouchDesigner
 */
export interface ParticleSpellProgram {
  version: '1.0';
  spellId: string;
  timestamp: number;

  // Spell identity
  intent: import('../../shared/types').SpellIntent | null;
  element: import('../../shared/types').SpellElement | null;
  archetype: ParticleSpellArchetype;

  // Visual mode
  mode: SpellVisualMode;

  // Energy envelope
  energy: number;           // 0-1, clamped to 0.55 max in buildup
  energyFloor: number;      // minimum energy (for idle drift)
  energyCeiling: number;    // maximum energy for this mode

  // Casting anchor
  castingOrigin: import('../../shared/types').CastingOrigin | null;
  castingLandmarks: number[]; // MediaPipe landmark indices for this origin

  // Color palette
  palette: SpellPalette;

  // Zone parameters (per-zone overrides)
  zones: Partial<Record<ShaderZoneName, ZoneParams>>;

  // Cast-specific (only populated in release mode)
  castEnvelope?: CastEnvelope;
}
