/**
 * Mentalist Module
 *
 * Exports for the mentalist reading experience.
 */

export { MentalistSession } from './session';
export type {
  OnRevealCallback,
  OnMoodChangeCallback,
  OnRequestAnalysisCallback,
  MentalistSessionConfig,
} from './session';

export { MentalistChat } from './gemini-chat';
export type { ChatTurnResult } from './gemini-chat';

export {
  MENTALIST_SYSTEM_PROMPT,
  MENTALIST_TOOLS,
  formatBodyContext,
  formatFaceContext,
  createTurnContext,
} from './prompts';

export type {
  MentalistPhase,
  MentalistMood,
  InsightType,
  MentalistInsight,
  MentalistSessionState,
  MentalistResponse,
  MentalistToolCall,
  RevealTriggerParams,
  SetMoodParams,
  ConversationMessage,
  MentalistUIUpdate,
} from './types';
