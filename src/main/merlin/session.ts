/**
 * MerlinSession - Manages the Merlin Mirror spell-casting experience
 *
 * Coordinates conversation, body/face analysis, and spell state accumulation.
 */

import { MerlinChat } from './gemini-chat';
import { createTurnContext } from './prompts';
import type {
  MerlinPhase,
  SpellState,
  MerlinResponse,
  MerlinConversationMessage,
} from '../../shared/types';
import type {
  MerlinSessionState,
  MerlinPhaseConfig,
  ConversationMessage,
} from './types';
import type { BodyLanguageAnalysis, MicroExpressionAnalysis } from '../../shared/types';
import { createInitialSpellState } from './spell-state';
import { pushSpellCast } from '../td-bridge';
import { resetTDBaseline } from './reset-td';
import { emitGeminiTurn, nextTurnId } from './gemini-events';
import { runMerlinTurn, dispatchToolCalls, type TurnDispatchContext } from './turn-runner';

// Default cast envelope timing (in ms). Used by triggerCast() to drive
// the release-mode TD-side phase transitions. Was previously archetype-
// specific via createReleaseProgram; collapsed to a single default now
// that the archetype layer is gone.
const DEFAULT_CAST_ENVELOPE = {
  ignitionMs: 400,
  projectionMs: 1200,
  afterglowMs: 2900,
  peakIntensity: 1.0,
};
function getCastDuration(env: typeof DEFAULT_CAST_ENVELOPE): number {
  return env.ignitionMs + env.projectionMs + env.afterglowMs;
}

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

    // Handle tool calls until we get text. Intro flow doesn't need a
    // sidebar turn id since it pre-dates user input — pass synthetic.
    const introTurnId = nextTurnId();
    const introZoneAttempts = new Map<string, number>();
    const ctx: TurnDispatchContext = {
      state: this.state,
      onSpellUpdate: this.config.onSpellUpdate,
      onRequestAnalysis: this.config.onRequestAnalysis,
    };
    // The intro flow doesn't expect request_visual_feedback (it runs
    // before any spell shaders exist), so dispatch.extraImages should
    // always be empty here. We dispatch only function responses; if a
    // tool ever does emit extras during intro, they'd be silently
    // dropped. The full image flow lives in runMerlinTurn.
    while (result.toolCalls.length > 0) {
      const dispatch = await dispatchToolCalls(result.toolCalls, ctx, introTurnId, 'live', introZoneAttempts);
      result = await this.chat.sendToolResults(dispatch.toolResults);
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

    // Open a sidebar turn for this user input.
    const turnId = nextTurnId();
    emitGeminiTurn({ id: turnId, source: 'live', userPrompt: transcript });

    // Run Gemini turn through the shared dispatcher.
    const ctx: TurnDispatchContext = {
      state: this.state,
      onSpellUpdate: this.config.onSpellUpdate,
      onRequestAnalysis: this.config.onRequestAnalysis,
    };
    const turn = await runMerlinTurn(this.chat, contextMessage, ctx, turnId, 'live');
    let accumulatedText = turn.finalText;

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
   * Used by the post-turn followUp prompt; main turn handling goes
   * through runMerlinTurn which emits its own events.
   */
  private emitChatResult(turnId: string, result: import('./gemini-chat').ChatTurnResult): void {
    const toolCalls = result.toolCalls.map(tc => ({
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

      // Visual state is now driven entirely by Gemini's set_zone_shader
      // calls during the conversation. On session end (outro), reset
      // zones to baseline so the next session starts clean.
      if (newPhase === 'outro') {
        void resetTDBaseline();
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

  // ===== Spell Cast =====

  /**
   * Trigger the spell cast effect. Called when magic word + casting
   * gesture are detected. Sends a `spell_cast` message to TD with a
   * default envelope; TD switches to release mode and animates the
   * release through the cast_state machinery. Visuals come from
   * whatever GLSL Gemini wrote into the zones via set_zone_shader.
   */
  triggerCast(): void {
    if (!this.state.castReady || this.state.castCompleted) {
      console.log('[MerlinSession] Cannot cast: not ready or already completed');
      return;
    }

    const envelope = DEFAULT_CAST_ENVELOPE;
    const durationMs = getCastDuration(envelope);

    pushSpellCast(
      this.state.spell.castingOrigin!,
      1.0,
      durationMs,
      envelope
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
