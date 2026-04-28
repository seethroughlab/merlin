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
  name: 'trigger_reveal' | 'set_mood' | 'request_body_analysis' | 'request_face_analysis' | 'get_question_template';
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
