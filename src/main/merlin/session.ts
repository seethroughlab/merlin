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
import { emitGeminiTurn, nextTurnId } from './gemini-events';
import type { GeminiToolCall } from '../../shared/types';

const LIVE_RETRY_MAX = 2;

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

    // Open a sidebar turn for this user input. Per-zone retry counts
    // live in this map for the duration of the turn (set_zone_shader
    // failures emit retry markers for the same zone).
    const turnId = nextTurnId();
    const zoneAttempts = new Map<string, number>();
    emitGeminiTurn({ id: turnId, source: 'live', userPrompt: transcript });

    // Send to Gemini
    let result = await this.chat.sendMessage(contextMessage);
    this.emitChatResult(turnId, result);

    // Accumulate text across all responses (ignore error placeholder)
    let accumulatedText = result.text === 'No response generated' ? '' : result.text;

    // Handle tool calls
    while (result.toolCalls.length > 0) {
      const toolResults = await this.handleToolCalls(result.toolCalls, turnId, zoneAttempts);
      result = await this.chat.sendToolResults(toolResults);
      this.emitChatResult(turnId, result);

      // Append any new text
      if (result.text && result.text !== 'No response generated') {
        accumulatedText += result.text;
      }
    }

    // If still no text after tool calls, ask for a spoken response
    if (!accumulatedText.trim()) {
      const followUp = await this.chat.sendMessage('Now respond to the user based on what you learned. Be brief.');
      this.emitChatResult(turnId, followUp);
      accumulatedText = followUp.text === 'No response generated' ? '' : followUp.text;
    }

    const responseText = accumulatedText || 'I see. Tell me more.';
    emitGeminiTurn({ id: turnId, source: 'live', responseText, final: true });

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
   * Emit Gemini's response (text + tool calls) to the sidebar.
   */
  private emitChatResult(turnId: string, result: ChatTurnResult): void {
    const toolCalls: GeminiToolCall[] = result.toolCalls.map(tc => ({
      name: tc.name,
      args: tc.args as Record<string, unknown>,
    }));
    const text = result.text === 'No response generated' ? '' : result.text;
    if (text || toolCalls.length > 0) {
      emitGeminiTurn({
        id: turnId,
        source: 'live',
        responseText: text || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });
    }
  }

  /**
   * Handle tool calls from Gemini
   */
  private async handleToolCalls(
    toolCalls: MerlinToolCall[],
    turnId?: string,
    zoneAttempts?: Map<string, number>,
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

          // Track per-zone attempt count within this turn so we can
          // mark retries in the sidebar and stop encouraging retries
          // after MAX_RETRIES.
          const priorAttempts = zoneAttempts?.get(zone) ?? 0;
          if (turnId && priorAttempts > 0) {
            emitGeminiTurn({
              id: turnId,
              source: 'live',
              retry: { attempt: priorAttempts, total: LIVE_RETRY_MAX, zone },
            });
          }

          // Push the GLSL code with full validation pipeline
          const result = await pushZoneUpdateWithValidation(zone, glsl_code);
          if (zoneAttempts) zoneAttempts.set(zone, priorAttempts + 1);

          console.log(
            `[MerlinSession] set_zone_shader: zone=${zone}, attempt=${priorAttempts + 1}, ` +
            `success=${result.success}, desc=${description || 'none'}` +
            `${result.error ? `, error=${result.error}` : ''}`
          );

          if (turnId) {
            emitGeminiTurn({
              id: turnId,
              source: 'live',
              pushResults: [{ zone, success: result.success, error: result.error, warnings: result.warnings }],
            });
          }

          if (result.success) {
            response = {
              success: true,
              zone,
              description: description || 'Custom shader applied',
              warnings: result.warnings,
            };
          } else {
            // Use vibe-agent's iterative-refinement phrasing so Gemini
            // produces better corrections. Capped at LIVE_RETRY_MAX
            // attempts per zone before we stop encouraging retries.
            const attempt = priorAttempts + 1;
            const exhausted = attempt > LIVE_RETRY_MAX;
            response = {
              success: false,
              zone,
              error: result.error,
              warnings: result.warnings,
              instruction: exhausted
                ? `The zone "${zone}" has now failed ${attempt} times. Stop trying to fix this zone for now and respond to the user.`
                : `COMPILE ERROR (iteration ${attempt}/${LIVE_RETRY_MAX}):\n\n` +
                  `Tool result for "${zone}": ${result.error ?? 'unknown error'}\n\n` +
                  `CRITICAL: The GLSL zone "${zone}" failed to compile. The zone code was reverted to defaults.\n` +
                  `You MUST call set_zone_shader again with corrected GLSL for zone "${zone}".\n` +
                  `Common fixes: check for syntax errors, undefined variables, missing semicolons, ` +
                  `redeclaration of template-provided variables, or invalid GLSL.\n` +
                  `Explain what you think went wrong and provide fixed code.`,
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

        case 'generate_sprite': {
          const {
            description,
            style,
            animation,
            frameCount,
            playbackMode,
            driveSource,
          } = call.args as {
            description: string;
            style?: string;
            animation?: string;
            frameCount?: number;
            playbackMode?: string;
            driveSource?: string;
          };

          console.log(`[MerlinSession] generate_sprite: description="${description}"${animation ? `, animation=${animation}` : ''}`);

          try {
            // Import sprite generator and push functions
            const { getSpriteGenerator } = await import('./sprite-generator');
            const { pushSpriteTexture, pushFlipbookConfig } = await import('../td-bridge');
            const { getFlipbookConfig } = await import('./asset-manager');

            const generator = getSpriteGenerator();

            // Determine if this is a flipbook request
            const isFlipbook = animation || (frameCount && frameCount > 1);

            if (isFlipbook) {
              // Generate flipbook
              const validFrameCount = (frameCount ?? 16) as 4 | 8 | 9 | 12 | 16 | 25;
              const result = await generator.generateFlipbookSync(description, {
                frameCount: validFrameCount,
                style,
                animation,
                playbackMode: (playbackMode ?? 'loop') as 'loop' | 'once' | 'pingpong' | 'random',
                driveSource: (driveSource ?? 'age') as 'age' | 'life' | 'velocity' | 'id' | 'time',
              });

              if (result.success && result.asset) {
                // Push texture and flipbook config to TD
                pushSpriteTexture(result.asset.assetId, result.asset.texturePath);
                if (result.flipbookConfig) {
                  pushFlipbookConfig(result.flipbookConfig);
                }

                response = {
                  success: true,
                  assetId: result.asset.assetId,
                  assetType: 'flipbook',
                  frameCount: result.asset.frameCount,
                  message: `Generated ${result.asset.frameCount}-frame flipbook sprite: "${description}"`,
                };
              } else {
                response = {
                  success: false,
                  error: result.error ?? 'Failed to generate flipbook sprite',
                };
              }
            } else {
              // Generate single sprite
              const result = await generator.generateSpriteSync(description, { style });

              if (result.success && result.asset) {
                // Push texture to TD
                pushSpriteTexture(result.asset.assetId, result.asset.texturePath);

                response = {
                  success: true,
                  assetId: result.asset.assetId,
                  assetType: 'single',
                  message: `Generated sprite: "${description}"`,
                };
              } else {
                response = {
                  success: false,
                  error: result.error ?? 'Failed to generate sprite',
                };
              }
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`[MerlinSession] generate_sprite error: ${errorMessage}`);
            response = {
              success: false,
              error: errorMessage,
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
