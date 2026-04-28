/**
 * Mentalist Session Types
 *
 * Types for the mentalist reading experience.
 */

import type { BodyLanguageAnalysis, MicroExpressionAnalysis } from '../../shared/types';

/**
 * Phases of the mentalist reading
 */
export type MentalistPhase = 'idle' | 'intro' | 'reading' | 'reveal' | 'finale';

/**
 * Visual mood settings
 */
export type MentalistMood = 'mysterious' | 'tension' | 'revelation' | 'warm' | 'contemplative';

/**
 * Types of insights the mentalist can reveal
 */
export type InsightType = 'emotion' | 'trait' | 'prediction' | 'observation' | 'secret';

/**
 * A single insight accumulated during the reading
 */
export interface MentalistInsight {
  id: string;
  type: InsightType;
  content: string;
  confidence: number;
  timestamp: number;
  revealed: boolean;
  bodyContext?: Partial<BodyLanguageAnalysis>;
  faceContext?: Partial<MicroExpressionAnalysis>;
}

/**
 * Session state for the mentalist reading
 */
export interface MentalistSessionState {
  phase: MentalistPhase;
  turnCount: number;
  insights: MentalistInsight[];
  currentMood: MentalistMood;
  emotionHistory: Array<{
    timestamp: number;
    valence: number;
    arousal: number;
    primaryEmotion: string;
  }>;
  bodyHistory: Array<{
    timestamp: number;
    openness: number;
    tension: number;
    engagement: number;
  }>;
}

/**
 * Response from processing user speech
 */
export interface MentalistResponse {
  text: string;
  phase: MentalistPhase;
  mood: MentalistMood;
  newInsights: MentalistInsight[];
  revealedInsight?: MentalistInsight;
}

/**
 * Tool call from Gemini
 */
export interface MentalistToolCall {
  name:
    | 'trigger_reveal'
    | 'set_mood'
    | 'request_body_analysis'
    | 'request_face_analysis'
    | 'get_question_template'
    | 'set_visual_scene'
    | 'trigger_visual_reveal'
    | 'set_skeleton_overlay';
  args: Record<string, unknown>;
}

/**
 * Reveal trigger parameters
 */
export interface RevealTriggerParams {
  type: InsightType;
  intensity: number; // 0-1
  text: string;
}

/**
 * Set mood parameters
 */
export interface SetMoodParams {
  mood: MentalistMood;
  colorAccent?: string; // hex color
  particleBehavior?: 'calm' | 'orbiting' | 'attracted' | 'repelled' | 'burst';
}

// ===== Visual Tool Parameter Types =====

/**
 * Parameters for set_visual_scene tool
 */
export interface SetVisualSceneParams {
  particle_intensity?: 'subtle' | 'moderate' | 'intense' | 'overwhelming';
  particle_behavior?: 'calm' | 'orbiting' | 'attracted' | 'repelled' | 'burst' | 'trailing';
  particle_color?: string; // hex color
  aura_color?: string; // hex color
  aura_size?: number; // 0-1
  background_mood?: 'mysterious' | 'warm' | 'cold' | 'electric' | 'transcendent';
}

/**
 * Parameters for trigger_visual_reveal tool
 */
export interface TriggerVisualRevealParams {
  effect_type: 'burst' | 'converge' | 'ripple' | 'ascend' | 'transform';
  color?: string; // hex color, defaults to mood-appropriate
  intensity: number; // 0-1
  duration?: number; // seconds, defaults to 2
  center_landmark?: number; // MediaPipe landmark index (0-32)
}

/**
 * Parameters for set_skeleton_overlay tool
 */
export interface SetSkeletonOverlayParams {
  overlays: Array<{
    landmark_start: number; // MediaPipe landmark index
    landmark_end: number; // MediaPipe landmark index
    effect: 'glow' | 'trail' | 'geometric' | 'energy_line';
    color: string; // hex color
    intensity: number; // 0-1
  }>;
}

/**
 * Conversation message
 */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  bodySnapshot?: Partial<BodyLanguageAnalysis>;
  faceSnapshot?: Partial<MicroExpressionAnalysis>;
}

/**
 * Data sent to renderer for UI updates
 */
export interface MentalistUIUpdate {
  phase: MentalistPhase;
  mood: MentalistMood;
  turnCount: number;
  lastMessage?: ConversationMessage;
  revealedInsights: MentalistInsight[];
  isListening: boolean;
  isProcessing: boolean;
}
