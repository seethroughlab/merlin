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
    | 'generate_sprite'
    | 'set_cast_params';
  args: Record<string, unknown>;
  /** Gemini-assigned id for this call. Used to pair the function response back to the call (genai SDK populates this when present). */
  id?: string;
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

// ============ CAST ENVELOPE ============

/**
 * Cast envelope timing (three-beat structure per PRD §8.3). Used by
 * triggerCast() to drive TD's release-mode phase transitions. Other
 * "particle spell program" types (archetypes, zone params, palettes
 * encoded as state) have been pruned — visuals come entirely from
 * Gemini's set_zone_shader calls.
 */
export interface CastEnvelope {
  ignitionMs: number;    // sharp rise at casting origin (default: 400)
  projectionMs: number;  // peak burst projected outward (default: 1200)
  afterglowMs: number;   // decay back to calmer buildup (default: 2900)
  peakIntensity: number; // 0-1
}

/**
 * Long-form zone names live alongside the templates (force_field,
 * spawn_behavior, ...). This export is kept as a stable string union
 * for any consumer that imports it; the previous short→long mapping
 * was tied to the deleted ZoneParams structure and is no longer
 * needed.
 */
export const ZONE_NAME_TO_TD: Record<string, string> = {
  force_field: 'force_field',
  spawn_behavior: 'spawn_behavior',
  velocity_modifier: 'velocity_modifier',
  size_over_life: 'size_over_life',
  color_over_life: 'color_over_life',
};
