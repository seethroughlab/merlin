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
    | 'prepare_casting';
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
