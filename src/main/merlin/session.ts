/**
 * MerlinSession - Manages the Merlin Mirror spell-casting experience
 *
 * Coordinates conversation, body/face analysis, and spell state accumulation.
 */

import { MerlinChat, ChatTurnResult } from './gemini-chat';
import { createTurnContext } from './prompts';
import type {
  MerlinPhase,
  SpellState,
  MerlinResponse,
  MerlinConversationMessage,
} from '../../shared/types';
import type {
  MerlinSessionState,
  MerlinToolCall,
  MerlinPhaseConfig,
  ConversationMessage,
  SetSpellProfileParams,
  PrepareCastingParams,
  BodySnapshot,
  FaceSnapshot,
} from './types';
import type { BodyLanguageAnalysis, MicroExpressionAnalysis } from '../../shared/types';
import {
  createInitialSpellState,
  mergeSpellUpdate,
  defaultOriginForIntent,
  paletteForElement,
} from './spell-state';
import {
  createBuildupProgram,
  createReleaseProgram,
  createIdleProgram,
  getCastDuration,
} from './particle-program';
import {
  pushParticleSpellProgram,
  pushSpellCast,
  pushZoneUpdateWithValidation,
} from '../td-bridge';

/**
 * Callback for when spell state updates
 */
export type OnSpellUpdateCallback = (spell: SpellState) => void;

/**
 * Callback for when phase changes
 */
export type OnPhaseChangeCallback = (phase: MerlinPhase) => void;

/**
 * Callback to request fresh analysis
 */
export type OnRequestAnalysisCallback = (
  type: 'body' | 'face',
  focus?: string
) => Promise<BodyLanguageAnalysis | MicroExpressionAnalysis | null>;

/**
 * Callback to capture current camera frame
 */
export type OnCaptureFrameCallback = () => Promise<string | null>;

/**
 * Default phase duration configuration
 */
const DEFAULT_PHASE_CONFIG: MerlinPhaseConfig = {
  introTurns: 1,
  discoveryTurns: 3,
  formationTurns: 1,
  castingTurns: 1,
  outroTurns: 1,
};

/**
 * Session configuration
 */
export interface MerlinSessionConfig {
  onSpellUpdate?: OnSpellUpdateCallback;
  onPhaseChange?: OnPhaseChangeCallback;
  onRequestAnalysis?: OnRequestAnalysisCallback;
  onCaptureFrame?: OnCaptureFrameCallback;
  onSessionComplete?: () => void;
  phaseConfig?: Partial<MerlinPhaseConfig>;
}

/**
 * MerlinSession class
 */
export class MerlinSession {
  private chat: MerlinChat;
  private state: MerlinSessionState;
  private conversationHistory: ConversationMessage[] = [];
  private config: MerlinSessionConfig;
  private phaseConfig: MerlinPhaseConfig;
  private previousPhase: MerlinPhase = 'idle';

  constructor(config: MerlinSessionConfig = {}) {
    this.chat = new MerlinChat();
    this.config = config;
    this.phaseConfig = { ...DEFAULT_PHASE_CONFIG, ...config.phaseConfig };
    this.state = this.createInitialState();
  }

  /**
   * Create the initial session state
   */
  private createInitialState(): MerlinSessionState {
    return {
      phase: 'idle',
      turnCount: 0,
      spell: createInitialSpellState(),
      conversationSummary: '',
      bodyHistory: [],
      faceHistory: [],
      castReady: false,
      castCompleted: false,
      lastUserInput: '',
      lastPosture: null,
      lastExpression: null,
      lastPerceptionTime: 0,
    };
  }

  /**
   * Start a new Merlin session
   */
  async startSession(): Promise<MerlinResponse> {
    this.state = this.createInitialState();
    this.conversationHistory = [];
    this.state.phase = 'intro';
    this.previousPhase = 'idle';

    // Notify phase change
    if (this.config.onPhaseChange) {
      this.config.onPhaseChange('intro');
    }

    // Try to capture a frame for personalized intro
    let result;
    if (this.config.onCaptureFrame) {
      const frameBase64 = await this.config.onCaptureFrame();
      if (frameBase64) {
        console.log('[MerlinSession] Starting with image-based intro');
        result = await this.chat.startChatWithImage(frameBase64);
      } else {
        console.log('[MerlinSession] Frame capture returned null, using text-only intro');
        result = await this.chat.startChat();
      }
    } else {
      console.log('[MerlinSession] No frame capture callback, using text-only intro');
      result = await this.chat.startChat();
    }

    // Handle tool calls until we get text
    while (result.toolCalls.length > 0) {
      const toolResults = await this.handleToolCalls(result.toolCalls);
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
      spell: this.state.spell,
    };
  }

  /**
   * Process user speech with body/face context
   */
  async processUserSpeech(
    transcript: string,
    bodyAnalysis: Partial<BodyLanguageAnalysis> | null,
    faceAnalysis: Partial<MicroExpressionAnalysis> | null
  ): Promise<MerlinResponse> {
    if (!this.chat.isActive()) {
      throw new Error('Session not started');
    }

    this.state.turnCount++;
    this.state.lastUserInput = transcript;

    // Update perception state
    if (bodyAnalysis) {
      this.state.lastPosture = bodyAnalysis;
      this.state.lastPerceptionTime = Date.now();
      this.state.bodyHistory.push({
        timestamp: Date.now(),
        openness: bodyAnalysis.openness ?? 0,
        tension: bodyAnalysis.tension ?? 0,
        engagement: bodyAnalysis.engagement ?? 0,
      });
    }

    if (faceAnalysis) {
      this.state.lastExpression = faceAnalysis;
      this.state.lastPerceptionTime = Date.now();
      this.state.faceHistory.push({
        timestamp: Date.now(),
        valence: faceAnalysis.valence ?? 0,
        arousal: faceAnalysis.arousal ?? 0,
        primaryEmotion: faceAnalysis.primaryEmotion ?? 'neutral',
      });
    }

    // Add user message to history
    this.conversationHistory.push({
      role: 'user',
      content: transcript,
      timestamp: Date.now(),
      bodySnapshot: bodyAnalysis ?? undefined,
      faceSnapshot: faceAnalysis ?? undefined,
    });

    // Determine phase based on turn count
    this.updatePhase();

    // Create context message for Gemini
    const contextMessage = createTurnContext(transcript, this.state);

    // Send to Gemini
    let result = await this.chat.sendMessage(contextMessage);

    // Accumulate text across all responses (ignore error placeholder)
    let accumulatedText = result.text === 'No response generated' ? '' : result.text;

    // Handle tool calls
    while (result.toolCalls.length > 0) {
      const toolResults = await this.handleToolCalls(result.toolCalls);
      result = await this.chat.sendToolResults(toolResults);

      // Append any new text
      if (result.text && result.text !== 'No response generated') {
        accumulatedText += result.text;
      }
    }

    // If still no text after tool calls, ask for a spoken response
    if (!accumulatedText.trim()) {
      const followUp = await this.chat.sendMessage('Now respond to the user based on what you learned. Be brief.');
      accumulatedText = followUp.text === 'No response generated' ? '' : followUp.text;
    }

    const responseText = accumulatedText || 'I see. Tell me more.';

    // Add assistant response to history
    this.conversationHistory.push({
      role: 'assistant',
      content: responseText,
      timestamp: Date.now(),
    });

    // Check for auto-end after outro
    const totalTurns = this.getTotalTurns();
    if (this.state.turnCount >= totalTurns && this.config.onSessionComplete) {
      this.config.onSessionComplete();
    }

    return {
      text: responseText,
      phase: this.state.phase,
      spell: this.state.spell,
    };
  }

  /**
   * Handle tool calls from Gemini
   */
  private async handleToolCalls(
    toolCalls: MerlinToolCall[]
  ): Promise<Array<{ name: string; response: unknown }>> {
    const results: Array<{ name: string; response: unknown }> = [];

    for (const call of toolCalls) {
      let response: unknown;

      switch (call.name) {
        case 'get_posture': {
          if (this.config.onRequestAnalysis) {
            const focus = (call.args as { focus?: string }).focus;
            const analysis = await this.config.onRequestAnalysis('body', focus);
            if (analysis) {
              this.state.lastPosture = analysis as Partial<BodyLanguageAnalysis>;
              this.state.lastPerceptionTime = Date.now();
            }
            response = analysis ?? { error: 'Analysis not available' };
          } else {
            // Return cached analysis
            response = this.state.lastPosture ?? { error: 'No posture data available' };
          }
          break;
        }

        case 'get_expression': {
          if (this.config.onRequestAnalysis) {
            const focus = (call.args as { focus?: string }).focus;
            const analysis = await this.config.onRequestAnalysis('face', focus);
            if (analysis) {
              this.state.lastExpression = analysis as Partial<MicroExpressionAnalysis>;
              this.state.lastPerceptionTime = Date.now();
            }
            response = analysis ?? { error: 'Analysis not available' };
          } else {
            // Return cached analysis
            response = this.state.lastExpression ?? { error: 'No expression data available' };
          }
          break;
        }

        case 'set_spell_profile': {
          const params = call.args as unknown as SetSpellProfileParams;

          // Merge spell update
          const update: Partial<SpellState> = {};

          if (params.intent) {
            update.intent = params.intent as SpellState['intent'];
            // Auto-set origin if not already set
            if (!this.state.spell.castingOrigin && update.intent) {
              update.castingOrigin = defaultOriginForIntent(update.intent);
            }
          }
          if (params.element) {
            update.element = params.element as SpellState['element'];
            // Auto-set palette if not already set
            if (!this.state.spell.palette && update.element) {
              update.palette = paletteForElement(update.element);
            }
          }
          if (params.tone) {
            update.tone = params.tone as SpellState['tone'];
          }
          if (typeof params.energy === 'number') {
            update.energy = params.energy;
          }
          if (params.castingOrigin) {
            update.castingOrigin = params.castingOrigin as SpellState['castingOrigin'];
          }
          if (params.visualArchetype) {
            update.visualArchetype = params.visualArchetype;
          }
          if (params.palette) {
            update.palette = params.palette;
          }

          // Increase confidence based on completeness
          const completenessBoost =
            (update.intent ? 0.15 : 0) +
            (update.element ? 0.15 : 0) +
            (update.castingOrigin ? 0.1 : 0);
          if (completenessBoost > 0) {
            update.confidence = Math.min(1, this.state.spell.confidence + completenessBoost);
          }

          this.state.spell = mergeSpellUpdate(this.state.spell, update);

          // Notify callback
          if (this.config.onSpellUpdate) {
            this.config.onSpellUpdate(this.state.spell);
          }

          // Push updated buildup program to TD
          this.pushCurrentBuildupProgram();

          response = {
            success: true,
            spell: this.state.spell,
          };
          break;
        }

        case 'prepare_casting': {
          const params = call.args as unknown as PrepareCastingParams;

          // Set magic word
          this.state.spell = mergeSpellUpdate(this.state.spell, {
            magicWord: params.magicWord,
            confidence: 1.0, // Ready to cast
          });

          this.state.castReady = true;

          // Notify callback
          if (this.config.onSpellUpdate) {
            this.config.onSpellUpdate(this.state.spell);
          }

          response = {
            success: true,
            magicWord: params.magicWord,
            gestureHint: params.gestureHint,
            spell: this.state.spell,
          };
          break;
        }

        case 'set_zone_shader': {
          const { zone, glsl_code, description } = call.args as {
            zone: string;
            glsl_code: string;
            description?: string;
          };

          // Push the GLSL code with full validation pipeline
          const result = await pushZoneUpdateWithValidation(zone, glsl_code);

          console.log(
            `[MerlinSession] set_zone_shader: zone=${zone}, success=${result.success}, ` +
            `desc=${description || 'none'}${result.error ? `, error=${result.error}` : ''}`
          );

          if (result.success) {
            response = {
              success: true,
              zone,
              description: description || 'Custom shader applied',
              warnings: result.warnings,
            };
          } else {
            response = {
              success: false,
              zone,
              error: result.error,
              warnings: result.warnings,
            };
          }
          break;
        }

        case 'request_visual_feedback': {
          const { intent } = call.args as { intent: string };

          console.log(`[MerlinSession] request_visual_feedback: intent=${intent}`);

          // Request screenshot from TD
          const { send } = await import('../td-bridge/connection');
          const { requestScreenshot } = await import('../td-bridge/metrics');

          const screenshot = await requestScreenshot(send, 5000);

          if (screenshot) {
            // Return screenshot data for Gemini to analyze
            response = {
              success: true,
              intent,
              screenshot: {
                base64: screenshot.base64,
                width: screenshot.width,
                height: screenshot.height,
              },
              instruction: 'Analyze this screenshot. Does it match the intended effect? If not, use set_zone_shader to refine.',
            };
          } else {
            response = {
              success: false,
              error: 'Failed to capture screenshot from TouchDesigner',
            };
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
    const { introTurns, discoveryTurns, formationTurns } = this.phaseConfig;

    const introEnd = introTurns;
    const discoveryEnd = introEnd + discoveryTurns;
    const formationEnd = discoveryEnd + formationTurns;

    let newPhase: MerlinPhase;
    if (turn <= introEnd) {
      newPhase = 'intro';
    } else if (turn <= discoveryEnd) {
      newPhase = 'discovery';
    } else if (turn <= formationEnd) {
      newPhase = 'formation';
    } else if (this.state.castReady && !this.state.castCompleted) {
      newPhase = 'ready_to_cast';
    } else if (this.state.castCompleted) {
      newPhase = 'outro';
    } else {
      // Still in formation if cast not ready
      newPhase = 'formation';
    }

    // Trigger phase change callback if phase changed
    if (newPhase !== this.previousPhase) {
      const wasDiscovery = this.previousPhase === 'discovery';
      this.previousPhase = newPhase;

      if (this.config.onPhaseChange) {
        this.config.onPhaseChange(newPhase);
      }

      // Push initial buildup program when entering discovery
      if (newPhase === 'discovery' && !wasDiscovery) {
        this.pushCurrentBuildupProgram();
      }

      // Push idle program when session ends
      if (newPhase === 'outro') {
        this.pushIdleProgram();
      }
    }

    this.state.phase = newPhase;
  }

  /**
   * Get total configured turns before auto-end
   */
  private getTotalTurns(): number {
    const { introTurns, discoveryTurns, formationTurns, castingTurns, outroTurns } = this.phaseConfig;
    return introTurns + discoveryTurns + formationTurns + castingTurns + outroTurns;
  }

  /**
   * Mark the spell as cast (called externally when gesture+word detected)
   */
  markCastCompleted(): void {
    this.state.castCompleted = true;
    this.state.phase = 'outro';
    if (this.config.onPhaseChange) {
      this.config.onPhaseChange('outro');
    }
  }

  /**
   * End the session
   */
  async endSession(): Promise<MerlinResponse> {
    if (!this.chat.isActive()) {
      return {
        text: 'Session was not active.',
        phase: 'idle',
        spell: createInitialSpellState(),
      };
    }

    this.state.phase = 'outro';

    const outroText = await this.chat.endSession();

    // Add to conversation history
    this.conversationHistory.push({
      role: 'assistant',
      content: outroText,
      timestamp: Date.now(),
    });

    const response: MerlinResponse = {
      text: outroText,
      phase: 'idle',
      spell: this.state.spell,
    };

    // Reset state
    this.state.phase = 'idle';

    return response;
  }

  /**
   * Get current session state
   */
  getState(): MerlinSessionState {
    return { ...this.state };
  }

  /**
   * Get current spell state
   */
  getSpell(): SpellState {
    return { ...this.state.spell };
  }

  /**
   * Get conversation history
   */
  getConversationHistory(): ConversationMessage[] {
    return [...this.conversationHistory];
  }

  /**
   * Check if session is active
   */
  isActive(): boolean {
    return this.chat.isActive();
  }

  // ===== Particle Program Integration =====

  /**
   * Push the current buildup program to TouchDesigner
   */
  private pushCurrentBuildupProgram(): void {
    const program = createBuildupProgram(this.state.spell);
    pushParticleSpellProgram('buildup', program);
  }

  /**
   * Push idle program to TouchDesigner (for session end)
   */
  private pushIdleProgram(): void {
    const program = createIdleProgram();
    pushParticleSpellProgram('idle', program);
  }

  /**
   * Trigger the spell cast effect
   * Called when magic word + casting gesture are detected
   */
  triggerCast(): void {
    if (!this.state.castReady || this.state.castCompleted) {
      console.log('[MerlinSession] Cannot cast: not ready or already completed');
      return;
    }

    const releaseProgram = createReleaseProgram(this.state.spell);
    const envelope = releaseProgram.castEnvelope!;
    const durationMs = getCastDuration(envelope);

    pushSpellCast(
      this.state.spell.castingOrigin!,
      1.0,
      durationMs,
      envelope,
      releaseProgram
    );

    this.markCastCompleted();
  }
}

/**
 * Factory function to create a new Merlin session
 */
export function createMerlinSession(config: MerlinSessionConfig = {}): MerlinSession {
  return new MerlinSession(config);
}
