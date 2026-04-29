/**
 * MentalistSession - Manages the mentalist reading experience
 *
 * Coordinates conversation, body/face analysis, and insight accumulation.
 */

import { MentalistChat, ChatTurnResult } from './gemini-chat';
import { createTurnContext } from './prompts';
import { getTemplates } from './questions';
import type {
  MentalistPhase,
  MentalistMood,
  MentalistSessionState,
  MentalistInsight,
  MentalistResponse,
  MentalistToolCall,
  RevealTriggerParams,
  SetMoodParams,
  SetVisualSceneParams,
  TriggerVisualRevealParams,
  SetSkeletonOverlayParams,
  UpdateParticleZoneParams,
  ConversationMessage,
} from './types';
import type { BodyLanguageAnalysis, MicroExpressionAnalysis } from '../../shared/types';
import {
  pushSceneParams,
  pushRevealEffect,
  pushSkeletonAugment,
  pushAuraUpdate,
  pushMoodUpdate,
  pushZoneUpdate,
  pushAnalysisUpdate,
  isConnected as isTDConnected,
  // Phase 4: Insight-driven visuals
  applySessionStartVisuals,
  applySessionEndVisuals,
  triggerPhaseTransition,
  updateVisualsForInsight,
  getInsightVisualEffect,
} from '../td-bridge';
import type { AnalysisUpdate } from '../td-bridge/types';

/**
 * Callback for when a reveal should be triggered
 */
export type OnRevealCallback = (params: RevealTriggerParams) => void;

/**
 * Callback for when mood changes
 */
export type OnMoodChangeCallback = (params: SetMoodParams) => void;

/**
 * Callback to request fresh analysis
 */
export type OnRequestAnalysisCallback = (type: 'body' | 'face', focus?: string) => Promise<BodyLanguageAnalysis | MicroExpressionAnalysis | null>;

/**
 * Phase duration configuration
 */
export interface PhaseConfig {
  introTurns: number;    // Number of turns in intro phase
  readingTurns: number;  // Number of turns in reading phase
  revealTurns: number;   // Number of turns in reveal phase
  finaleTurns: number;   // Number of turns in finale before auto-end
}

const DEFAULT_PHASE_CONFIG: PhaseConfig = {
  introTurns: 2,
  readingTurns: 4,
  revealTurns: 2,
  finaleTurns: 1,
};

/**
 * Session configuration
 */
export interface MentalistSessionConfig {
  onReveal?: OnRevealCallback;
  onMoodChange?: OnMoodChangeCallback;
  onRequestAnalysis?: OnRequestAnalysisCallback;
  phaseConfig?: Partial<PhaseConfig>;
  onSessionComplete?: () => void;
}

/**
 * Generate a unique ID for insights
 */
function generateId(): string {
  return `insight_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Wrap a GLSL code snippet in the full shader template for the given zone
 */
function wrapGLSLSnippet(zone: 'force_field' | 'color_over_life', snippet: string): string {
  if (zone === 'force_field') {
    return `uniform float uTime;

void main() {
    uint id = TDIndex();
    if (id >= TDNumElements())
        return;

    vec3 pos = TDIn_P();

    // === ZONE CODE START ===
    ${snippet}
    // === ZONE CODE END ===

    P[id] = pos;
}
`;
  } else if (zone === 'color_over_life') {
    return `uniform float uTime;

void main() {
    uint id = TDIndex();
    if (id >= TDNumElements())
        return;

    vec3 pos = TDIn_P();
    vec3 col = vec3(1.0);

    // === ZONE CODE START ===
    ${snippet}
    // === ZONE CODE END ===

    color[id] = col;
}
`;
  }
  return snippet; // Fallback
}

/**
 * MentalistSession class
 */
export class MentalistSession {
  private chat: MentalistChat;
  private state: MentalistSessionState;
  private conversationHistory: ConversationMessage[] = [];
  private config: MentalistSessionConfig;
  private phaseConfig: PhaseConfig;
  private previousPhase: MentalistPhase = 'idle';

  constructor(config: MentalistSessionConfig = {}) {
    this.chat = new MentalistChat();
    this.config = config;
    this.phaseConfig = { ...DEFAULT_PHASE_CONFIG, ...config.phaseConfig };
    this.state = this.createInitialState();
  }

  /**
   * Create the initial session state
   */
  private createInitialState(): MentalistSessionState {
    return {
      phase: 'idle',
      turnCount: 0,
      insights: [],
      currentMood: 'mysterious',
      emotionHistory: [],
      bodyHistory: [],
    };
  }

  /**
   * Start a new mentalist session
   */
  async startSession(): Promise<MentalistResponse> {
    this.state = this.createInitialState();
    this.conversationHistory = [];
    this.state.phase = 'intro';
    this.previousPhase = 'idle';

    // Set initial mood
    if (this.config.onMoodChange) {
      this.config.onMoodChange({ mood: 'mysterious', particleBehavior: 'calm' });
    }

    // Apply intro visuals to TouchDesigner
    applySessionStartVisuals();

    let result = await this.chat.startChat();
    const newInsights: MentalistInsight[] = [];

    // Handle tool calls (like set_mood) until we get text
    while (result.toolCalls.length > 0) {
      const toolResults = await this.handleToolCalls(result.toolCalls, newInsights);
      result = await this.chat.sendToolResults(toolResults);
    }

    const introText = result.text;

    // Add to conversation history
    this.conversationHistory.push({
      role: 'assistant',
      content: introText,
      timestamp: Date.now(),
    });

    return {
      text: introText,
      phase: this.state.phase,
      mood: this.state.currentMood,
      newInsights,
    };
  }

  /**
   * Process user speech with body/face context
   */
  async processUserSpeech(
    transcript: string,
    bodyAnalysis: Partial<BodyLanguageAnalysis> | null,
    faceAnalysis: Partial<MicroExpressionAnalysis> | null
  ): Promise<MentalistResponse> {
    if (!this.chat.isActive()) {
      throw new Error('Session not started');
    }

    this.state.turnCount++;

    // Add user message to history
    this.conversationHistory.push({
      role: 'user',
      content: transcript,
      timestamp: Date.now(),
      bodySnapshot: bodyAnalysis ?? undefined,
      faceSnapshot: faceAnalysis ?? undefined,
    });

    // Track analysis history
    if (faceAnalysis) {
      this.state.emotionHistory.push({
        timestamp: Date.now(),
        valence: faceAnalysis.valence ?? 0,
        arousal: faceAnalysis.arousal ?? 0,
        primaryEmotion: faceAnalysis.primaryEmotion ?? 'neutral',
      });
    }

    if (bodyAnalysis) {
      this.state.bodyHistory.push({
        timestamp: Date.now(),
        openness: bodyAnalysis.openness ?? 0,
        tension: bodyAnalysis.tension ?? 0,
        engagement: bodyAnalysis.engagement ?? 0,
      });
    }

    // Determine phase based on turn count
    this.updatePhase();

    // Create context message for Gemini (include previous insights to prevent repeats)
    const previousInsights = this.state.insights.map((i) => ({
      type: i.type,
      content: i.content,
    }));
    const contextMessage = createTurnContext(
      transcript,
      bodyAnalysis,
      faceAnalysis,
      this.state.turnCount,
      this.state.phase,
      previousInsights
    );

    // Send to Gemini
    let result = await this.chat.sendMessage(contextMessage);
    const newInsights: MentalistInsight[] = [];
    let revealedInsight: MentalistInsight | undefined;

    // Accumulate text across all responses (tool calls may split the response)
    let accumulatedText = result.text;

    // Handle tool calls
    while (result.toolCalls.length > 0) {
      const toolResults = await this.handleToolCalls(result.toolCalls, newInsights);

      // Check if a reveal was triggered
      for (const call of result.toolCalls) {
        if (call.name === 'trigger_reveal') {
          const insight = newInsights.find((i) => !i.revealed);
          if (insight) {
            insight.revealed = true;
            revealedInsight = insight;
          }
        }
      }

      // Send tool results back
      result = await this.chat.sendToolResults(toolResults);

      // Append any new text from this response
      if (result.text && result.text !== 'No response generated') {
        accumulatedText += result.text;
      }
    }

    // Use accumulated text (may be empty if only tool calls were returned)
    const responseText = accumulatedText || result.text;

    // Add assistant response to history
    this.conversationHistory.push({
      role: 'assistant',
      content: responseText,
      timestamp: Date.now(),
    });

    // Store new insights
    this.state.insights.push(...newInsights);

    // Push analysis values to TD for "mirror/echo" visuals
    if (isTDConnected() && (bodyAnalysis || faceAnalysis)) {
      const analysisUpdate: AnalysisUpdate = {
        valence: faceAnalysis?.valence ?? 0,
        arousal: faceAnalysis?.arousal ?? 0,
        tension: bodyAnalysis?.tension ?? 0,
        openness: bodyAnalysis?.openness ?? 0,
        engagement: bodyAnalysis?.engagement ?? 0,
        primary_emotion: this.mapEmotionToCategory(faceAnalysis?.primaryEmotion),
      };
      pushAnalysisUpdate(analysisUpdate);
    }

    // Check for auto-end after finale response
    const totalTurns = this.getTotalTurns();
    if (this.state.turnCount >= totalTurns && this.config.onSessionComplete) {
      // Notify that session should end (after this response plays)
      this.config.onSessionComplete();
    }

    return {
      text: responseText,
      phase: this.state.phase,
      mood: this.state.currentMood,
      newInsights,
      revealedInsight,
    };
  }

  /**
   * Map a detected emotion string to one of the supported categories
   */
  private mapEmotionToCategory(emotion: string | undefined): AnalysisUpdate['primary_emotion'] {
    if (!emotion) return 'neutral';

    const normalized = emotion.toLowerCase();

    // Map common variations to our supported categories
    if (['joy', 'happy', 'happiness', 'content', 'pleased', 'elated'].includes(normalized)) {
      return 'joy';
    }
    if (['fear', 'afraid', 'scared', 'anxious', 'nervous', 'worried'].includes(normalized)) {
      return 'fear';
    }
    if (['anger', 'angry', 'frustrated', 'irritated', 'annoyed'].includes(normalized)) {
      return 'anger';
    }
    if (['sadness', 'sad', 'melancholy', 'dejected', 'unhappy', 'grief'].includes(normalized)) {
      return 'sadness';
    }
    if (['surprise', 'surprised', 'shocked', 'astonished', 'amazed'].includes(normalized)) {
      return 'surprise';
    }

    return 'neutral';
  }

  /**
   * Handle tool calls from Gemini
   */
  private async handleToolCalls(
    toolCalls: MentalistToolCall[],
    insightAccumulator: MentalistInsight[]
  ): Promise<Array<{ name: string; response: unknown }>> {
    const results: Array<{ name: string; response: unknown }> = [];

    for (const call of toolCalls) {
      let response: unknown;

      switch (call.name) {
        case 'trigger_reveal': {
          const params = call.args as unknown as RevealTriggerParams;

          // Create insight
          const insight: MentalistInsight = {
            id: generateId(),
            type: params.type,
            content: params.text,
            confidence: params.intensity,
            timestamp: Date.now(),
            revealed: false,
          };
          insightAccumulator.push(insight);

          // Trigger visual effect callback
          if (this.config.onReveal) {
            this.config.onReveal(params);
          }

          // Apply insight-specific visual effect to TouchDesigner
          if (isTDConnected()) {
            const visualEffect = getInsightVisualEffect(params.type, params.intensity);

            // Push reveal effect
            pushRevealEffect(
              visualEffect.effect_type,
              visualEffect.intensity,
              visualEffect.duration,
              visualEffect.center_landmark
            );

            // Push skeleton overlays if defined
            if (visualEffect.skeletonOverlays && visualEffect.skeletonOverlays.length > 0) {
              pushSkeletonAugment(visualEffect.skeletonOverlays);
            }

            // Update accumulated visuals
            const allRevealed = [...this.state.insights.filter((i) => i.revealed), insight]
              .map((i) => ({ type: i.type, confidence: i.confidence }));
            updateVisualsForInsight(allRevealed, this.state.phase);
          }

          response = { success: true, insightId: insight.id };
          break;
        }

        case 'set_mood': {
          const params = call.args as unknown as SetMoodParams;
          this.state.currentMood = params.mood;

          if (this.config.onMoodChange) {
            this.config.onMoodChange(params);
          }

          // Also push to TouchDesigner if connected
          if (isTDConnected()) {
            pushMoodUpdate(params.mood, params.colorAccent);
          }

          response = { success: true, mood: params.mood };
          break;
        }

        case 'request_body_analysis': {
          if (this.config.onRequestAnalysis) {
            const focus = (call.args as { focus?: string }).focus;
            const analysis = await this.config.onRequestAnalysis('body', focus);
            response = analysis ?? { error: 'Analysis not available' };
          } else {
            response = { error: 'Analysis callback not configured' };
          }
          break;
        }

        case 'request_face_analysis': {
          if (this.config.onRequestAnalysis) {
            const focus = (call.args as { focus?: string }).focus;
            const analysis = await this.config.onRequestAnalysis('face', focus);
            response = analysis ?? { error: 'Analysis not available' };
          } else {
            response = { error: 'Analysis callback not configured' };
          }
          break;
        }

        case 'get_question_template': {
          const category = (call.args as { category: 'intro' | 'transition' | 'reveal' | 'probing' | 'physical' }).category;
          const templates = getTemplates(category, 3);
          response = {
            category,
            templates,
            note: 'Use these for inspiration - adapt to the current context and your observations',
          };
          break;
        }

        // ===== Visual Tools for TouchDesigner =====

        case 'set_visual_scene': {
          const params = call.args as unknown as SetVisualSceneParams;

          if (isTDConnected()) {
            // Push scene parameters
            pushSceneParams({
              particle_intensity: params.particle_intensity,
              particle_behavior: params.particle_behavior,
              particle_color: params.particle_color,
              aura_color: params.aura_color,
              aura_size: params.aura_size,
              background_mood: params.background_mood,
            });

            // Also update aura separately if specified
            if (params.aura_color && params.aura_size !== undefined) {
              pushAuraUpdate(
                params.aura_color,
                params.aura_size,
                params.particle_behavior || 'calm'
              );
            }

            response = { success: true, applied: params };
          } else {
            response = { success: false, error: 'TouchDesigner not connected' };
          }
          break;
        }

        case 'trigger_visual_reveal': {
          const params = call.args as unknown as TriggerVisualRevealParams;

          if (isTDConnected()) {
            pushRevealEffect(
              params.effect_type,
              params.intensity,
              params.duration ?? 2,
              params.center_landmark
            );
            response = { success: true, effect: params.effect_type };
          } else {
            response = { success: false, error: 'TouchDesigner not connected' };
          }
          break;
        }

        case 'set_skeleton_overlay': {
          const params = call.args as unknown as SetSkeletonOverlayParams;

          if (isTDConnected()) {
            pushSkeletonAugment(params.overlays);
            response = { success: true, overlayCount: params.overlays.length };
          } else {
            response = { success: false, error: 'TouchDesigner not connected' };
          }
          break;
        }

        case 'update_particle_zone': {
          const params = call.args as unknown as UpdateParticleZoneParams;

          if (isTDConnected()) {
            // Wrap the user's GLSL snippet in the full shader template
            const fullShader = wrapGLSLSnippet(params.zone, params.glsl_code);
            pushZoneUpdate(params.zone, fullShader);
            console.log(`[Mentalist] Zone ${params.zone} updated: ${params.description || 'no description'}`);
            response = { success: true, zone: params.zone };
          } else {
            response = { success: false, error: 'TouchDesigner not connected' };
          }
          break;
        }

        default:
          response = { error: `Unknown tool: ${call.name}` };
      }

      results.push({ name: call.name, response });
    }

    return results;
  }

  /**
   * Update phase based on conversation progress
   */
  private updatePhase(): void {
    const turn = this.state.turnCount;
    const { introTurns, readingTurns, revealTurns } = this.phaseConfig;

    const introEnd = introTurns;
    const readingEnd = introEnd + readingTurns;
    const revealEnd = readingEnd + revealTurns;

    let newPhase: MentalistPhase;
    if (turn <= introEnd) {
      newPhase = 'intro';
    } else if (turn <= readingEnd) {
      newPhase = 'reading';
    } else if (turn <= revealEnd) {
      newPhase = 'reveal';
    } else {
      newPhase = 'finale';
    }

    // Trigger visual transition if phase changed
    if (newPhase !== this.previousPhase) {
      const revealedInsights = this.state.insights
        .filter((i) => i.revealed)
        .map((i) => ({ type: i.type, confidence: i.confidence }));

      triggerPhaseTransition(this.previousPhase, newPhase, revealedInsights);
      this.previousPhase = newPhase;
    }

    this.state.phase = newPhase;
  }

  /**
   * Get total configured turns before auto-end
   */
  private getTotalTurns(): number {
    const { introTurns, readingTurns, revealTurns, finaleTurns } = this.phaseConfig;
    return introTurns + readingTurns + revealTurns + finaleTurns;
  }

  /**
   * End the session
   */
  async endSession(): Promise<MentalistResponse> {
    if (!this.chat.isActive()) {
      return {
        text: 'Session was not active.',
        phase: 'idle',
        mood: 'warm',
        newInsights: [],
      };
    }

    this.state.phase = 'finale';

    // Set warm closing mood
    if (this.config.onMoodChange) {
      this.config.onMoodChange({ mood: 'warm', particleBehavior: 'calm' });
    }

    // Apply finale visuals to TouchDesigner
    const revealedInsights = this.state.insights
      .filter((i) => i.revealed)
      .map((i) => ({ type: i.type, confidence: i.confidence }));
    applySessionEndVisuals(revealedInsights);

    const finaleText = await this.chat.endSession();

    // Add to conversation history
    this.conversationHistory.push({
      role: 'assistant',
      content: finaleText,
      timestamp: Date.now(),
    });

    const response: MentalistResponse = {
      text: finaleText,
      phase: 'idle',
      mood: 'warm',
      newInsights: [],
    };

    // Reset state
    this.state.phase = 'idle';

    return response;
  }

  /**
   * Get current session state
   */
  getState(): MentalistSessionState {
    return { ...this.state };
  }

  /**
   * Get conversation history
   */
  getConversationHistory(): ConversationMessage[] {
    return [...this.conversationHistory];
  }

  /**
   * Get all revealed insights
   */
  getRevealedInsights(): MentalistInsight[] {
    return this.state.insights.filter((i) => i.revealed);
  }

  /**
   * Check if session is active
   */
  isActive(): boolean {
    return this.chat.isActive();
  }
}
