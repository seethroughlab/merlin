/**
 * Turn-state FSM — the renderer's per-turn audio/mic/UI lifecycle.
 *
 * Replaces the previous bag of `let` flags (merlinIsListening,
 * inFlightSpeechPromise, isProcessingMerlinTranscript, plus several
 * voiceStatus write sites) with a single source of truth.
 *
 * Lives alongside (not replacing) `session.phase` in the main process.
 * `session.phase` is the spell-building arc (intro → discovery → … →
 * outro); this FSM is the mechanical pipeline (audio playing? mic open?
 * which UI label?). The two are independent — main's phase changes
 * don't drive this FSM, and vice versa.
 *
 * Design notes:
 * - Pure reducer. `transition(state, ctx, event)` returns the next
 *   state + context without side effects. Easy to unit-test, easy to
 *   reason about.
 * - Consumers SUBSCRIBE. Nobody mutates the state directly. UI label
 *   updates, mic open/close, and TTS gating all flow through the
 *   subscription list.
 * - Events are timestamped and logged. Today's race-condition bugs
 *   become impossible because every state change is the result of a
 *   named event with a known order, not a polled-flag check.
 */

export type TurnState =
  | 'idle'                // session not active
  | 'intro_speaking'      // intro audio playing
  | 'listening'           // mic open, waiting for user speech
  | 'thinking'            // transcript sent, awaiting main; no audio yet
  | 'chunk_speaking'      // initial chunk audio playing (turn may or may not have resolved in main)
  | 'working'             // chunk audio done; main still processing tools
  | 'remainder_speaking'  // post-tool remainder audio playing
  | 'resuming'            // turn done, mic about to reopen
  | 'play'                // post-cast, user inhabits the spell freely
  | 'outro_speaking';     // session-end finale playing

/**
 * Extra state carried alongside the discrete state. Two flags, both
 * scoped to a single chunk-speaking lifecycle:
 *
 *  - `expectRemainder` — set on ENTRY to `chunk_speaking` from the
 *    chunk.text-arrived event. True for filler chunks (Gemini emitted
 *    tools but no text; renderer played a pre-canned filler; the real
 *    ack arrives post-tool). False for real chunks (Gemini's actual
 *    text response; post-tool text is dropped per the
 *    chunkAlreadyResponded rule).
 *
 *  - `pendingRemainder` — set when `turn.resolved` arrives DURING
 *    chunk_speaking. On the following tts.complete the FSM uses this
 *    to fork: → remainder_speaking | → resuming. Distinct from
 *    expectRemainder because the latter is set at entry and reflects
 *    intent; pendingRemainder is set later and reflects the resolved
 *    truth from main.
 */
export interface TurnContext {
  expectRemainder: boolean;
  pendingRemainder: boolean | null;
}

export type TurnEvent =
  | { type: 'session.start' }
  | { type: 'session.stop' }
  | { type: 'tts.complete' }
  | { type: 'whisper.transcript'; text: string }
  | { type: 'chunk.text-arrived'; text: string; expectRemainder: boolean }
  | { type: 'turn.resolved'; hasRemainder: boolean }
  | { type: 'mic.opened' }
  | { type: 'cast.triggered' }
  | { type: 'session.complete' };

export type TurnEventType = TurnEvent['type'];

const INITIAL_CONTEXT: TurnContext = { expectRemainder: false, pendingRemainder: null };

/**
 * Pure transition function. Returns the next state + context for a
 * given (state, context, event) input. If the event isn't valid in
 * the current state, returns the unchanged state — making the FSM
 * tolerant to spurious events (e.g. tts.complete arriving while idle).
 */
export function transition(
  state: TurnState,
  ctx: TurnContext,
  event: TurnEvent,
): { state: TurnState; ctx: TurnContext } {
  // Global stops first — session.stop / cast.triggered / session.complete
  // override the per-state routing because they represent operator-level
  // actions that always win.
  if (event.type === 'session.stop') {
    return { state: 'idle', ctx: INITIAL_CONTEXT };
  }
  if (event.type === 'cast.triggered') {
    // Cast is fire-and-forget from the FSM's perspective; once it
    // triggers, we land in play and stay there until session.complete.
    return { state: 'play', ctx: INITIAL_CONTEXT };
  }
  if (event.type === 'session.complete') {
    return { state: 'outro_speaking', ctx: INITIAL_CONTEXT };
  }

  switch (state) {
    case 'idle': {
      if (event.type === 'session.start') {
        return { state: 'intro_speaking', ctx: INITIAL_CONTEXT };
      }
      return { state, ctx };
    }

    case 'intro_speaking': {
      if (event.type === 'tts.complete') {
        // Route through resuming so the physical mic-open is handled
        // in one place (the mic subscriber waits for resuming, calls
        // startContinuousListening, then dispatches mic.opened).
        return { state: 'resuming', ctx: INITIAL_CONTEXT };
      }
      return { state, ctx };
    }

    case 'listening': {
      if (event.type === 'whisper.transcript') {
        return { state: 'thinking', ctx: INITIAL_CONTEXT };
      }
      return { state, ctx };
    }

    case 'thinking': {
      if (event.type === 'chunk.text-arrived') {
        return {
          state: 'chunk_speaking',
          ctx: { expectRemainder: event.expectRemainder, pendingRemainder: null },
        };
      }
      if (event.type === 'turn.resolved') {
        // No chunk fired; main returned directly. Spoken text (if any)
        // gets played through the remainder path, otherwise we resume.
        return {
          state: event.hasRemainder ? 'remainder_speaking' : 'resuming',
          ctx: INITIAL_CONTEXT,
        };
      }
      return { state, ctx };
    }

    case 'chunk_speaking': {
      if (event.type === 'tts.complete') {
        // Audio done. Decision tree:
        //  1. turn.resolved already arrived during chunk_speaking
        //     (pendingRemainder is non-null) → use it as the authority.
        //  2. otherwise, fall back to the entry-time expectation:
        //     - expectRemainder=true (filler) → working, wait for the
        //       real ack to come post-tool.
        //     - expectRemainder=false (real chunk) → resuming, open
        //       the mic immediately. The chunkAlreadyResponded rule
        //       means main will drop any post-tool text, so there's
        //       nothing more to wait for.
        if (ctx.pendingRemainder === true) {
          return { state: 'remainder_speaking', ctx: INITIAL_CONTEXT };
        }
        if (ctx.pendingRemainder === false) {
          return { state: 'resuming', ctx: INITIAL_CONTEXT };
        }
        return {
          state: ctx.expectRemainder ? 'working' : 'resuming',
          ctx: INITIAL_CONTEXT,
        };
      }
      if (event.type === 'turn.resolved') {
        // Turn done, but audio still playing. Stash hasRemainder in
        // context and wait for tts.complete to choose the exit branch.
        return { state, ctx: { ...ctx, pendingRemainder: event.hasRemainder } };
      }
      return { state, ctx };
    }

    case 'working': {
      if (event.type === 'turn.resolved') {
        return {
          state: event.hasRemainder ? 'remainder_speaking' : 'resuming',
          ctx: INITIAL_CONTEXT,
        };
      }
      return { state, ctx };
    }

    case 'remainder_speaking': {
      if (event.type === 'tts.complete') {
        return { state: 'resuming', ctx: INITIAL_CONTEXT };
      }
      return { state, ctx };
    }

    case 'resuming': {
      if (event.type === 'mic.opened') {
        return { state: 'listening', ctx: INITIAL_CONTEXT };
      }
      return { state, ctx };
    }

    case 'play': {
      // Magic-word utterances during play re-trigger casts via the
      // background listener (outside this FSM). No transitions here
      // until session.complete (handled globally above).
      return { state, ctx };
    }

    case 'outro_speaking': {
      if (event.type === 'tts.complete') {
        return { state: 'idle', ctx: INITIAL_CONTEXT };
      }
      return { state, ctx };
    }
  }
}

/**
 * Subscriber callback. Fires after every dispatch — even when the
 * state didn't change — so consumers can choose whether to filter on
 * (prev !== next) themselves.
 */
export type TurnStateListener = (
  state: TurnState,
  prev: TurnState,
  event: TurnEvent,
  ctx: TurnContext,
) => void;

let currentState: TurnState = 'idle';
let currentCtx: TurnContext = INITIAL_CONTEXT;
const listeners: TurnStateListener[] = [];

/** Apply an event. Logs the transition and notifies subscribers. */
export function dispatch(event: TurnEvent): void {
  const prev = currentState;
  const result = transition(currentState, currentCtx, event);
  currentState = result.state;
  currentCtx = result.ctx;

  if (prev !== currentState) {
    console.log(`[TurnState] ${prev} → ${currentState} (${event.type})`);
  } else {
    // No-op events are useful diagnostics in dev — log at a lower
    // intensity so the console isn't flooded.
    console.debug(`[TurnState] ${prev} (no change, ${event.type})`);
  }

  for (const l of listeners) l(currentState, prev, event, currentCtx);
}

export function subscribe(listener: TurnStateListener): () => void {
  listeners.push(listener);
  return () => {
    const i = listeners.indexOf(listener);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function getState(): TurnState {
  return currentState;
}

export function getContext(): TurnContext {
  return currentCtx;
}

/** Test-only: reset internal state. Not exported for production use. */
export function _resetForTest(): void {
  currentState = 'idle';
  currentCtx = INITIAL_CONTEXT;
  listeners.length = 0;
}

/**
 * UI label and CSS class for each state. Single source of truth for
 * the voice-status indicator — `merlin-ui.ts` subscribes and writes
 * these directly. No per-site `voiceStatus.textContent = …` writes.
 */
export const STATE_LABEL: Record<TurnState, string> = {
  idle: 'Shift+M to begin',
  intro_speaking: 'Speaking...',
  listening: 'Listening...',
  thinking: 'Thinking...',
  chunk_speaking: 'Speaking...',
  working: 'Thinking...',
  remainder_speaking: 'Speaking...',
  // resuming is "mic is async-opening, FSM is about to transition to
  // listening on mic.opened". Label it as Listening because that's
  // what the user perceives — Merlin's done, conversation is theirs.
  // The ~500ms physical mic-open delay is invisible in practice.
  resuming: 'Listening...',
  play: 'Listening (free)...',
  outro_speaking: 'Speaking...',
};

export const STATE_CSS_CLASS: Record<TurnState, string> = {
  idle: '',
  intro_speaking: 'speaking',
  listening: 'listening',
  thinking: 'processing',
  chunk_speaking: 'speaking',
  working: 'processing',
  remainder_speaking: 'speaking',
  resuming: 'listening',
  play: 'listening',
  outro_speaking: 'speaking',
};

/**
 * Whether the mic should be open in a given state. Used by the
 * mic-management subscriber to call start/stopContinuousListening.
 */
export const MIC_OPEN_IN: ReadonlySet<TurnState> = new Set([
  'listening',
  'play',
]);
