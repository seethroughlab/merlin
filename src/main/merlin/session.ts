/**
 * MerlinSession - Manages the Merlin Mirror spell-casting experience
 *
 * Coordinates conversation, body/face analysis, and spell state accumulation.
 */

import { MerlinChat } from './gemini-chat';
import { createTurnContext } from './session-context';
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
import { createInitialSpellState, isSpellReady, transcriptMatchesMagicWord, transcriptContains } from './spell-state';
import { pushSpellCast } from '../td-bridge';
import { resetTDBaseline } from './reset-td';
import { emitGeminiTurn, nextTurnId } from './gemini-events';
import { runMerlinTurn, dispatchToolCalls, type TurnDispatchContext, type EffectTriggerSpec } from './turn-runner';
import { pushZoneUpdateWithValidation } from '../td-bridge';
import { summarizeRecentFaceActivity } from './face-event-buffer';
import { log } from '../logger';

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

// After the cast, the participant enters PLAY mode to inhabit the spell.
// Re-speaking the magic word resets the inactivity timer. If they wander
// off and never re-cast, the safety timer auto-closes the session.
const PLAY_PHASE_MAX_MS = 60_000;

// Cap on conversationHistory length. Each turn pushes 1–2 messages
// (user + assistant); 200 entries covers ~100 turns which is well past
// any realistic single session. Without a cap, long-running test
// sessions accumulate forever.
const MAX_HISTORY_MESSAGES = 200;

// Invoke a config callback, logging any throw instead of letting it
// propagate. Callbacks are owned by index.ts (IPC layer); a bad listener
// must not be allowed to kill the in-progress session turn.
function safeInvoke(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log.error('MerlinSession', `callback "${label}" threw:`, err);
  }
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
  // Intro is the SESSION-START narration (fired by startSession before
  // any user speech). The first user-speech turn is already discovery —
  // they're responding to Merlin's opening. introTurns=0 means
  // updatePhase moves us into discovery on turn 1, NOT keeping us in
  // intro where the narrowed tool set would force Gemini into a retry
  // loop with all its visual tools getting dropped.
  introTurns: 0,
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
  /**
   * Optional hook fired when Gemini's FIRST response on a turn carries
   * text alongside pending tool calls. Main process forwards the text
   * to the renderer's LiveTTS so speech starts in parallel with the
   * (potentially slow) tool dispatch — masking 25s Imagen calls behind
   * the spoken description of the spell.
   */
  onSpeakChunk?: (text: string) => void;
  /**
   * Fired when prepare_casting dispatches — the moment Merlin declares
   * the magic word. Main wires this to an IPC that arms the renderer's
   * background cast listener so the cast trigger is decoupled from the
   * Gemini conversation pipeline.
   */
  onCastArmed?: (payload: { magicWord: string; gestureHint?: string }) => void;
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
  private playSafetyTimer: NodeJS.Timeout | null = null;
  // Effect-trigger words registered by Gemini via register_effect_triggers.
  // Matched locally in processUserSpeech BEFORE the magic-word check, so
  // utterances like "rise" fire the registered GLSL in ~400ms instead of
  // round-tripping through Gemini.
  private effectTriggers: EffectTriggerSpec[] = [];

  constructor(config: MerlinSessionConfig = {}) {
    this.chat = new MerlinChat();
    this.config = config;
    this.phaseConfig = { ...DEFAULT_PHASE_CONFIG, ...config.phaseConfig };
    this.state = this.createInitialState();
  }

  /**
   * Append to conversation history and trim to MAX_HISTORY_MESSAGES so
   * long-running sessions don't accumulate unbounded memory.
   */
  private pushHistory(message: ConversationMessage): void {
    this.conversationHistory.push(message);
    if (this.conversationHistory.length > MAX_HISTORY_MESSAGES) {
      this.conversationHistory.splice(0, this.conversationHistory.length - MAX_HISTORY_MESSAGES);
    }
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
        log.info('MerlinSession', 'Starting with image-based intro');
        result = await this.chat.startChatWithImage(frameBase64);
      } else {
        log.info('MerlinSession', 'Frame capture returned null, using text-only intro');
        result = await this.chat.startChat();
      }
    } else {
      log.info('MerlinSession', 'No frame capture callback, using text-only intro');
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
    // Parallel TTS: if the FIRST intro response already carries text
    // alongside tool calls (typical — "Welcome, traveler. Let me see…"
    // + set_zone_shader), forward the greeting to TTS immediately
    // while the tool loop runs. Caller's startMerlinMode then receives
    // an empty response.text and skips the post-loop TTS so it doesn't
    // double-speak.
    let introStreamedText = '';
    if (result.text && result.toolCalls.length > 0 && this.config.onSpeakChunk) {
      this.config.onSpeakChunk(result.text);
      introStreamedText = result.text;
    }
    // The intro flow doesn't expect request_visual_feedback (it runs
    // before any spell shaders exist), so dispatch.extraImages should
    // always be empty here. We dispatch only function responses; if a
    // tool ever does emit extras during intro, they'd be silently
    // dropped. The full image flow lives in runMerlinTurn.
    let accumulatedIntroText = result.text;
    // Hard cap on intro tool-dispatch rounds. The prompt forbids tools,
    // the gate blocks all but perception + spell_profile, but a stubborn
    // model could still loop on rejected calls. Two rounds is enough for
    // Gemini to receive the synthetic "tool unavailable" error and
    // resign to text-only — more than that just delays the greeting.
    const INTRO_MAX_DISPATCH_ROUNDS = 2;
    let introRound = 0;
    while (result.toolCalls.length > 0 && introRound < INTRO_MAX_DISPATCH_ROUNDS) {
      const dispatch = await dispatchToolCalls(result.toolCalls, ctx, introTurnId, 'live', introZoneAttempts);
      result = await this.chat.sendToolResults(dispatch.toolResults);
      if (result.text && result.text !== 'No response generated') {
        accumulatedIntroText += result.text;
      }
      introRound++;
    }
    if (result.toolCalls.length > 0) {
      log.info('MerlinSession', `Intro hit ${INTRO_MAX_DISPATCH_ROUNDS}-round tool cap with ${result.toolCalls.length} calls pending — proceeding with whatever text we have`);
    }

    // Full text for the chat-history bubble (initial chunk + post-tool).
    // spokenText is just the un-streamed remainder so the renderer
    // doesn't kick off a second speakWithStreaming that would cancel
    // the in-flight chunk mid-playback.
    const introFullText = accumulatedIntroText;
    const introSpokenText = introStreamedText
      ? accumulatedIntroText.slice(introStreamedText.length)
      : accumulatedIntroText;

    // Add the full text to conversation history (everything Gemini said,
    // streamed + post-tool). The chat-bubble display reads from this.
    this.pushHistory({
      role: 'assistant',
      content: introFullText,
      timestamp: Date.now(),
    });

    return {
      text: introFullText,
      phase: this.state.phase,
      spell: this.state.spell,
      spokenText: introSpokenText,
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

    // Snapshot the entry phase. Play-phase logic below keys off this:
    // - phaseAtEntry !== 'play' AND magic-word matches → first cast; run Gemini for welcome line
    // - phaseAtEntry === 'play' → all speech is silent (magic-word visual + timer reset handled above)
    const phaseAtEntry = this.state.phase;

    // Local effect-trigger match (registered via register_effect_triggers).
    // Runs BEFORE the magic word and BEFORE Gemini — utterances like
    // "rise" or "still" land in ~400ms instead of the full Gemini round
    // trip. Triggers fire visual-only; no Gemini turn is consumed.
    const trigger = this.effectTriggers.find(t => transcriptContains(transcript, t.word));
    if (trigger) {
      log.info(
        'MerlinSession',
        `Effect trigger "${trigger.word}" matched in "${transcript}" — firing ${trigger.zone}`,
      );
      void pushZoneUpdateWithValidation(trigger.zone, trigger.glslCode);
      // Don't return — the magic-word check should still run on the same
      // utterance, since "rise" + "{magic word}" in one breath is valid.
    }

    // Magic-word cast trigger. Fire BEFORE the Gemini turn so the cast
    // envelope (mode_float=1.0 → energy tween) starts immediately as the
    // participant finishes speaking. On first cast this advances phase to
    // 'play' via markCastCompleted; on subsequent utterances during play
    // it re-fires the visual envelope only (the participant can keep
    // hitting the cast as they inhabit the spell).
    const magicMatched = transcriptMatchesMagicWord(transcript, this.state.spell.magicWord);
    if (magicMatched) {
      log.info(
        'MerlinSession',
        `Magic word "${this.state.spell.magicWord}" matched in transcript "${transcript}" — triggering cast`,
      );
      this.triggerCast();
    }

    // Already in play: all speech is silent. Magic-word visual and timer
    // reset are already handled above by triggerCast(); nothing more to do.
    if (phaseAtEntry === 'play') {
      return {
        text: '',
        phase: this.state.phase,
        spell: this.state.spell,
        spokenText: '',
      };
    }

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
    this.pushHistory({
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

    // Snapshot the face-activity line that buildSessionContext just
    // injected (it called the same summarizer internally). Surfaced
    // to the LIVE sidebar card so the user can verify exactly what
    // Gemini was told about face state — observability for the
    // FaceLandmarker → buffer → context pipeline.
    const faceActivity = summarizeRecentFaceActivity();
    if (faceActivity) {
      log.info('MerlinSession', `Injecting FACE ACTIVITY: "${faceActivity}"`);
    }

    // Open a sidebar turn for this user input.
    const turnId = nextTurnId();
    emitGeminiTurn({
      id: turnId,
      source: 'live',
      userPrompt: transcript,
      ...(faceActivity ? { faceActivity } : {}),
    });

    // Run Gemini turn through the shared dispatcher.
    const ctx: TurnDispatchContext = {
      state: this.state,
      onSpellUpdate: this.config.onSpellUpdate,
      onRequestAnalysis: this.config.onRequestAnalysis,
      onRegisterTriggers: (triggers) => {
        // Replace the full set; Gemini calling this tool again redefines
        // the entire trigger library, not appends. Matches what the tool
        // description tells the model.
        this.effectTriggers = [...triggers];
        log.info(
          'MerlinSession',
          `Effect triggers updated (${this.effectTriggers.length}): ` +
          this.effectTriggers.map(t => `"${t.word}"→${t.zone}`).join(', '),
        );
      },
      onSpeakChunk: this.config.onSpeakChunk
        ? (text: string) => safeInvoke('onSpeakChunk', () => this.config.onSpeakChunk!(text))
        : undefined,
      onCastArmed: ({ magicWord, gestureHint }) => {
        safeInvoke('onCastArmed', () => {
          this.config.onCastArmed?.({ magicWord, gestureHint });
        });
      },
    };
    const turn = await runMerlinTurn(this.chat, contextMessage, ctx, turnId, 'live');
    let accumulatedText = turn.finalText;

    // Followup re-prompt — used to be unconditional on empty text, but
    // that fires even when the chunk path already streamed the response
    // (which made finalText empty as the un-streamed remainder). The
    // followup then generated a SECOND response that played over the
    // chunk via stopStreaming(). Only re-prompt if nothing was streamed
    // AND nothing landed in the final text.
    if (!accumulatedText.trim() && !turn.streamedAny) {
      const followUp = await this.chat.sendMessage('Now respond to the user based on what you learned. Be brief.');
      this.emitChatResult(turnId, followUp);
      accumulatedText = followUp.text === 'No response generated' ? '' : followUp.text;
    }

    // For the chat-history bubble, use the FULL accumulated text (the
    // initial chunk + any post-tool follow-up). For the spoken-text
    // path, use only the un-streamed remainder so the chunk doesn't get
    // cancelled by a second speakWithStreaming. If nothing streamed and
    // nothing came back from tools, fall back to the placeholder.
    const fullText = (turn.streamedAny ? turn.fullText : accumulatedText) || 'I see. Tell me more.';
    const spokenText = turn.streamedAny
      ? turn.finalText // un-streamed remainder; may be empty if entire response was streamed
      : (accumulatedText || 'I see. Tell me more.');
    // Final marker only — the response text was already emitted to the
    // sidebar by emitChatResult inside runMerlinTurn (or the followUp
    // emitChatResult above), so re-emitting responseText here creates a
    // duplicate Gemini card. The `final: true` flag is purely cosmetic
    // (locks the card visually); the renderer doesn't need the text.
    emitGeminiTurn({ id: turnId, source: 'live', final: true });

    // Add assistant response to history
    this.pushHistory({
      role: 'assistant',
      content: fullText,
      timestamp: Date.now(),
    });

    // Check for auto-end after outro
    const totalTurns = this.getTotalTurns();
    if (this.state.turnCount >= totalTurns && this.config.onSessionComplete) {
      this.config.onSessionComplete();
    }

    return {
      text: fullText,
      phase: this.state.phase,
      spell: this.state.spell,
      spokenText,
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
      // Stay in 'play' while the participant inhabits the spell; closePlay()
      // explicitly sets 'outro' when the timer fires.
      newPhase = this.state.phase === 'play' ? 'play' : 'outro';
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
   * Mark the spell as cast and enter PLAY phase. Gemini speaks a brief
   * welcome line on the same turn, then goes silent. The 60-second
   * inactivity timer resets every time the magic word is detected.
   */
  markCastCompleted(): void {
    this.state.castCompleted = true;
    this.state.phase = 'play';
    this.previousPhase = 'play';
    this.resetPlayTimer();
    if (this.config.onPhaseChange) {
      this.config.onPhaseChange('play');
    }
  }

  private resetPlayTimer(): void {
    if (this.playSafetyTimer) clearTimeout(this.playSafetyTimer);
    this.playSafetyTimer = setTimeout(() => {
      log.info('MerlinSession', `Play phase inactivity timer expired (${PLAY_PHASE_MAX_MS}ms) — closing session`);
      this.closePlay();
    }, PLAY_PHASE_MAX_MS);
  }

  /**
   * Close the PLAY phase on inactivity timeout. Idempotent — calling
   * twice is safe (the timer is cleared on first call).
   */
  private closePlay(): void {
    if (this.playSafetyTimer) {
      clearTimeout(this.playSafetyTimer);
      this.playSafetyTimer = null;
    }
    this.state.phase = 'outro';
    this.previousPhase = 'outro';
    if (this.config.onPhaseChange) {
      this.config.onPhaseChange('outro');
    }
    void resetTDBaseline();
    if (this.config.onSessionComplete) {
      this.config.onSessionComplete();
    }
  }

  /**
   * End the session
   */
  async endSession(): Promise<MerlinResponse> {
    // Clear the play-phase safety timer first. If endSession races with
    // a timer fire (e.g. user-initiated stopMerlinMode while the 60s
    // timer is about to expire), the timer's closePlay→onSessionComplete
    // would double up with the renderer's own teardown path.
    if (this.playSafetyTimer) {
      clearTimeout(this.playSafetyTimer);
      this.playSafetyTimer = null;
    }

    if (!this.chat.isActive()) {
      return {
        text: 'Session was not active.',
        phase: 'idle',
        spell: createInitialSpellState(),
        spokenText: 'Session was not active.',
      };
    }

    this.state.phase = 'outro';

    // If the cast already happened, the cast turn's Gemini response
    // already produced the closing narration that's being TTS'd as
    // we speak. Calling chat.endSession() here would generate a
    // SECOND outro and try to play it concurrently — the participant
    // hears two overlapping wizards. Skip the second Gemini call;
    // return empty text so stopMerlinMode's TTS guard is a no-op.
    if (this.state.castCompleted) {
      log.info('MerlinSession', 'endSession: cast already produced the closing narration; skipping second outro');
      const response: MerlinResponse = {
        text: '',
        phase: 'idle',
        spell: this.state.spell,
        spokenText: '',
      };
      this.state.phase = 'idle';
      return response;
    }

    const outroText = await this.chat.endSession();

    // Add to conversation history
    this.pushHistory({
      role: 'assistant',
      content: outroText,
      timestamp: Date.now(),
    });

    const response: MerlinResponse = {
      text: outroText,
      phase: 'idle',
      spell: this.state.spell,
      spokenText: outroText,
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
    if (!this.state.castReady || !isSpellReady(this.state.spell)) {
      log.info('MerlinSession', 'Cannot cast: spell not ready');
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

    // The peak-hold + idle restore are handled TD-side now. The
    // cast_decay_tick executeDAT polls each frame and resets
    // spell_state['mode_float'] to -1.0 once CAST_PEAK_HOLD_SEC
    // elapses since cast_start_time. Robust to Node disconnects.
    // See ws_callbacks.py:check_cast_decay.

    // First cast: markCastCompleted sets phase to 'play' and starts the
    // inactivity timer. Subsequent casts during play reset the timer so
    // active participants get a full 60s from their last magic-word utterance.
    if (!this.state.castCompleted) {
      this.markCastCompleted();
    } else if (this.state.phase === 'play') {
      log.info('MerlinSession', 'Re-cast during play — resetting inactivity timer');
      this.resetPlayTimer();
    }
  }
}

/**
 * Factory function to create a new Merlin session
 */
export function createMerlinSession(config: MerlinSessionConfig = {}): MerlinSession {
  return new MerlinSession(config);
}
