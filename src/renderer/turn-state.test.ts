import { describe, it, expect, beforeEach } from 'vitest';
import {
  transition,
  dispatch,
  subscribe,
  getState,
  getContext,
  _resetForTest,
  STATE_LABEL,
  STATE_CSS_CLASS,
  MIC_OPEN_IN,
  type TurnState,
  type TurnContext,
  type TurnEvent,
} from './turn-state';

const EMPTY_CTX: TurnContext = { expectRemainder: false, pendingRemainder: null };

/** Helper: apply a sequence of events starting from a known state. */
function run(
  startState: TurnState,
  events: TurnEvent[],
  startCtx: TurnContext = EMPTY_CTX,
): { state: TurnState; ctx: TurnContext } {
  let s = startState;
  let c = startCtx;
  for (const e of events) {
    const r = transition(s, c, e);
    s = r.state;
    c = r.ctx;
  }
  return { state: s, ctx: c };
}

describe('turn-state — transitions', () => {
  describe('happy path (real-chunk turn: common case)', () => {
    it('idle → intro → resuming → listening → thinking → chunk_speaking → resuming → listening (mic opens immediately after chunk audio)', () => {
      // Note: NO `working` state in this path. The whole point of the
      // expectRemainder=false branch is to open the mic the moment
      // Merlin's audio ends, instead of waiting for main's dispatch
      // loop. turn.resolved arrives later and is a no-op (already in
      // listening with hasRemainder=false).
      expect(run('idle', [
        { type: 'session.start' },         // → intro_speaking
        { type: 'tts.complete' },          // → resuming
        { type: 'mic.opened' },            // → listening
        { type: 'whisper.transcript', text: 'hello' }, // → thinking
        { type: 'chunk.text-arrived', text: 'merlin reply', expectRemainder: false }, // → chunk_speaking
        { type: 'tts.complete' },          // → resuming (mic re-opens)
        { type: 'mic.opened' },            // → listening
      ]).state).toBe('listening');
    });

    it('intro_speaking → resuming on tts.complete (every back-to-listening path is uniform)', () => {
      expect(transition('intro_speaking', EMPTY_CTX, { type: 'tts.complete' }).state).toBe('resuming');
    });

    it('chunk_speaking exits directly to resuming when expectRemainder=false (no working state)', () => {
      const enter = transition('thinking', EMPTY_CTX, {
        type: 'chunk.text-arrived',
        text: 'reply',
        expectRemainder: false,
      });
      expect(enter.state).toBe('chunk_speaking');
      expect(enter.ctx.expectRemainder).toBe(false);

      const exit = transition(enter.state, enter.ctx, { type: 'tts.complete' });
      expect(exit.state).toBe('resuming');
    });
  });

  describe('filler turn (rare: Gemini emitted tools-only, real ack comes post-tool)', () => {
    it('chunk_speaking exits to working when expectRemainder=true, then plays remainder', () => {
      // Filler chunk played; real ack will arrive after dispatch loop.
      const after = run('thinking', [
        { type: 'chunk.text-arrived', text: '<filler>', expectRemainder: true },
        { type: 'tts.complete' },          // → working (NOT resuming — wait for post-tool ack)
        { type: 'turn.resolved', hasRemainder: true }, // → remainder_speaking
        { type: 'tts.complete' },          // → resuming
        { type: 'mic.opened' },            // → listening
      ]);
      expect(after.state).toBe('listening');
    });

    it('chunk_speaking with expectRemainder=true → working on tts.complete', () => {
      const enter = transition('thinking', EMPTY_CTX, {
        type: 'chunk.text-arrived',
        text: '<filler>',
        expectRemainder: true,
      });
      expect(enter.state).toBe('chunk_speaking');
      expect(enter.ctx.expectRemainder).toBe(true);

      const exit = transition(enter.state, enter.ctx, { type: 'tts.complete' });
      expect(exit.state).toBe('working');
    });
  });

  describe('chunk_speaking — race orderings (pendingRemainder overrides expectRemainder)', () => {
    // The race-ordering tests use expectRemainder=true (filler context)
    // to verify that pendingRemainder (set by an early turn.resolved)
    // wins over the entry-time expectation. This exercises the path
    // that's NOT taken on the common-case real-chunk path (which would
    // exit directly to resuming on tts.complete without ever needing
    // pendingRemainder).
    const fillerCtx: TurnContext = { expectRemainder: true, pendingRemainder: null };

    it('tts.complete before turn.resolved (filler) → goes through working', () => {
      // Audio ended first, then main resolved with no remainder.
      const after = transition('chunk_speaking', fillerCtx, { type: 'tts.complete' });
      expect(after.state).toBe('working');
      const after2 = transition(after.state, after.ctx, {
        type: 'turn.resolved',
        hasRemainder: false,
      });
      expect(after2.state).toBe('resuming');
    });

    it('turn.resolved (no remainder) before tts.complete → resuming on audio end', () => {
      const after = transition('chunk_speaking', fillerCtx, {
        type: 'turn.resolved',
        hasRemainder: false,
      });
      expect(after.state).toBe('chunk_speaking');
      expect(after.ctx.pendingRemainder).toBe(false);

      const after2 = transition(after.state, after.ctx, { type: 'tts.complete' });
      expect(after2.state).toBe('resuming');
    });

    it('turn.resolved (with remainder) before tts.complete → remainder_speaking on audio end', () => {
      const after = transition('chunk_speaking', fillerCtx, {
        type: 'turn.resolved',
        hasRemainder: true,
      });
      expect(after.ctx.pendingRemainder).toBe(true);

      const after2 = transition(after.state, after.ctx, { type: 'tts.complete' });
      expect(after2.state).toBe('remainder_speaking');
    });
  });

  describe('thinking — no-chunk path', () => {
    it('turn.resolved with remainder → remainder_speaking', () => {
      expect(run('thinking', [
        { type: 'turn.resolved', hasRemainder: true },
      ]).state).toBe('remainder_speaking');
    });

    it('turn.resolved without remainder → resuming', () => {
      expect(run('thinking', [
        { type: 'turn.resolved', hasRemainder: false },
      ]).state).toBe('resuming');
    });
  });

  describe('cast and outro (global events)', () => {
    it('cast.triggered from any active state → play', () => {
      const states: TurnState[] = ['listening', 'thinking', 'chunk_speaking', 'working', 'remainder_speaking', 'resuming'];
      for (const s of states) {
        expect(transition(s, EMPTY_CTX, { type: 'cast.triggered' }).state).toBe('play');
      }
    });

    it('session.complete from play → outro_speaking → idle', () => {
      const after = run('play', [
        { type: 'session.complete' },
        { type: 'tts.complete' },
      ]);
      expect(after.state).toBe('idle');
    });

    it('session.stop from any state → idle', () => {
      const states: TurnState[] = ['intro_speaking', 'listening', 'thinking', 'chunk_speaking', 'working', 'remainder_speaking', 'resuming', 'play', 'outro_speaking'];
      for (const s of states) {
        expect(transition(s, EMPTY_CTX, { type: 'session.stop' }).state).toBe('idle');
      }
    });
  });

  describe('spurious events (no-ops)', () => {
    it('tts.complete in idle is a no-op', () => {
      expect(transition('idle', EMPTY_CTX, { type: 'tts.complete' }).state).toBe('idle');
    });

    it('whisper.transcript in thinking is a no-op', () => {
      // Whisper finalizing a transcript while a turn is mid-processing
      // shouldn't try to start another turn; the renderer's reentry
      // guard handles that, but the FSM should also be tolerant.
      expect(transition('thinking', EMPTY_CTX, {
        type: 'whisper.transcript',
        text: 'late',
      }).state).toBe('thinking');
    });

    it('chunk.text-arrived in working is a no-op', () => {
      // Once we're in working (audio done, tools running) a stray
      // chunk event shouldn't move state.
      expect(transition('working', EMPTY_CTX, {
        type: 'chunk.text-arrived',
        text: 'late chunk',
        expectRemainder: false,
      }).state).toBe('working');
    });

    it('mic.opened in listening is a no-op', () => {
      expect(transition('listening', EMPTY_CTX, { type: 'mic.opened' }).state).toBe('listening');
    });
  });

  describe('dispatch + subscribe (mutable singleton API)', () => {
    beforeEach(() => {
      _resetForTest();
    });

    it('starts in idle', () => {
      expect(getState()).toBe('idle');
      expect(getContext()).toEqual(EMPTY_CTX);
    });

    it('dispatch advances state', () => {
      dispatch({ type: 'session.start' });
      expect(getState()).toBe('intro_speaking');
    });

    it('subscribers fire on every dispatch', () => {
      const seen: string[] = [];
      subscribe((state, prev, event) => {
        seen.push(`${prev}→${state}:${event.type}`);
      });
      dispatch({ type: 'session.start' });
      dispatch({ type: 'tts.complete' });
      expect(seen).toEqual([
        'idle→intro_speaking:session.start',
        'intro_speaking→resuming:tts.complete',
      ]);
    });

    it('unsubscribe removes the listener', () => {
      let calls = 0;
      const off = subscribe(() => { calls++; });
      dispatch({ type: 'session.start' });
      expect(calls).toBe(1);
      off();
      dispatch({ type: 'tts.complete' });
      expect(calls).toBe(1);
    });
  });
});

describe('turn-state — derived metadata', () => {
  it('every state has a label and a CSS class', () => {
    const states: TurnState[] = [
      'idle', 'intro_speaking', 'listening', 'thinking',
      'chunk_speaking', 'working', 'remainder_speaking',
      'resuming', 'play', 'outro_speaking',
    ];
    for (const s of states) {
      expect(STATE_LABEL[s]).toBeDefined();
      expect(STATE_CSS_CLASS[s]).toBeDefined();
    }
  });

  it('MIC_OPEN_IN includes listening + play only', () => {
    expect(MIC_OPEN_IN.has('listening')).toBe(true);
    expect(MIC_OPEN_IN.has('play')).toBe(true);
    expect(MIC_OPEN_IN.has('chunk_speaking')).toBe(false);
    expect(MIC_OPEN_IN.has('thinking')).toBe(false);
    expect(MIC_OPEN_IN.has('working')).toBe(false);
    expect(MIC_OPEN_IN.has('resuming')).toBe(false);
  });
});
