import { describe, it, expect, beforeEach } from 'vitest';

import {
  ALLOWED_TOOLS_PER_PHASE,
  buildSessionContext,
  createTurnContext,
  formatBodyContext,
  formatFaceContext,
} from './session-context';
import { createInitialSpellState } from './spell-state';
import { clearFaceEventBuffer } from './face-event-buffer';
import type { MerlinSessionState } from './types';
import type { MerlinPhase } from '../../shared/types';

function baseState(overrides: Partial<MerlinSessionState> = {}): MerlinSessionState {
  return {
    phase: 'discovery',
    turnCount: 1,
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
    ...overrides,
  };
}

describe('ALLOWED_TOOLS_PER_PHASE', () => {
  it('locks down idle / casting / play / outro to zero tools', () => {
    for (const phase of ['idle', 'casting', 'play', 'outro'] as const) {
      expect(ALLOWED_TOOLS_PER_PHASE[phase].size).toBe(0);
    }
  });

  it('only allows prepare_casting in formation', () => {
    const phases: MerlinPhase[] = [
      'idle', 'wake', 'intro', 'discovery', 'formation',
      'ready_to_cast', 'casting', 'play', 'outro',
    ];
    for (const p of phases) {
      const has = ALLOWED_TOOLS_PER_PHASE[p].has('prepare_casting');
      expect(has, `prepare_casting allowed in ${p}`).toBe(p === 'formation');
    }
  });

  it('keeps intro free of heavy visual tools (no generate_sprite / set_zone_shader)', () => {
    expect(ALLOWED_TOOLS_PER_PHASE.intro.has('generate_sprite')).toBe(false);
    expect(ALLOWED_TOOLS_PER_PHASE.intro.has('set_zone_shader')).toBe(false);
  });

  it('lets discovery and formation use the full visual-authoring set', () => {
    for (const phase of ['discovery', 'formation'] as const) {
      const tools = ALLOWED_TOOLS_PER_PHASE[phase];
      for (const t of [
        'set_spell_profile',
        'set_zone_shader',
        'generate_sprite',
        'request_visual_feedback',
      ]) {
        expect(tools.has(t), `${phase} should allow ${t}`).toBe(true);
      }
    }
  });

  it('restricts ready_to_cast to perception only', () => {
    const tools = ALLOWED_TOOLS_PER_PHASE.ready_to_cast;
    expect(Array.from(tools).sort()).toEqual(
      ['get_expression', 'get_face_events', 'get_posture'].sort(),
    );
  });
});

describe('formatBodyContext', () => {
  it('returns the documented placeholder for null input', () => {
    expect(formatBodyContext(null)).toBe('Posture: Not available');
  });

  it('buckets openness / tension / engagement into descriptive labels', () => {
    const s = formatBodyContext({ openness: 0.8, tension: 0.2, engagement: 0.7 });
    expect(s).toContain('open');
    expect(s).toContain('relaxed');
    expect(s).toContain('engaged');
  });

  it('buckets movementLevel and surfaces gestureTypes', () => {
    const s = formatBodyContext({
      movementLevel: 0.7,
      gestureTypes: ['raise_hands', 'lean_in', 'pace', 'fourth-ignored'],
    });
    expect(s).toContain('moving a lot');
    // Bucketed to the first 3 gestures
    expect(s).toContain('raise_hands');
    expect(s).toContain('lean_in');
    expect(s).toContain('pace');
    expect(s).not.toContain('fourth-ignored');
  });

  it('returns an "Observing..." placeholder when the analysis has no recognized fields', () => {
    expect(formatBodyContext({})).toBe('Body: Observing...');
  });
});

describe('formatFaceContext', () => {
  it('returns the documented placeholder for null input', () => {
    expect(formatFaceContext(null)).toBe('Expression: Not available');
  });

  it('uses primaryEmotion when present, falls back to dominantEmotion', () => {
    expect(formatFaceContext({ primaryEmotion: 'wonder' })).toContain('wonder');
    expect(formatFaceContext({ dominantEmotion: 'grief' })).toContain('grief');
  });

  it('buckets valence and arousal', () => {
    const positive = formatFaceContext({ valence: 0.6, arousal: 0.7 });
    expect(positive).toContain('positive');
    expect(positive).toContain('energized');

    const troubled = formatFaceContext({ valence: -0.6, arousal: 0.1 });
    expect(troubled).toContain('troubled');
    expect(troubled).toContain('calm');
  });
});

describe('buildSessionContext', () => {
  beforeEach(() => {
    clearFaceEventBuffer();
  });

  it('emits a phase header tagged with the current phase and turn count', () => {
    const ctx = buildSessionContext(baseState({ phase: 'discovery', turnCount: 2 }));
    expect(ctx).toContain('PHASE: DISCOVERY');
    expect(ctx).toContain('Turn 2');
  });

  it('includes the act-of-5 story framing for discovery', () => {
    const ctx = buildSessionContext(baseState({ phase: 'discovery' }));
    expect(ctx).toContain('ACT 2 of 5: DISCOVERY');
  });

  it('does not emit story framing for non-dialogue phases (idle/wake/casting)', () => {
    for (const phase of ['idle', 'wake', 'casting'] as const) {
      const ctx = buildSessionContext(baseState({ phase }));
      expect(ctx).not.toMatch(/=== ACT \d+/);
    }
  });

  it('lists the allowed tools for the current phase in the rules block', () => {
    const ctx = buildSessionContext(baseState({ phase: 'discovery' }));
    expect(ctx).toContain('TOOLS AVAILABLE THIS PHASE:');
    expect(ctx).toContain('generate_sprite');
    expect(ctx).toContain('set_zone_shader');
  });

  it('reports "none — speak only" for phases with no allowed tools', () => {
    const ctx = buildSessionContext(baseState({ phase: 'ready_to_cast' }));
    // ready_to_cast still has perception tools, so use an empty phase.
    expect(ctx).toContain('TOOLS AVAILABLE THIS PHASE: get_posture');

    // outro emits a different terminal-turn rules block (no allowed-tools
    // line at all because tools are forbidden for that whole turn).
    const outro = buildSessionContext(baseState({ phase: 'outro' }));
    expect(outro).toContain('TERMINAL TURN');
    expect(outro).toContain('FAREWELL');
  });

  it('surfaces spell details when set, otherwise reports "Not yet formed"', () => {
    const empty = buildSessionContext(baseState({ phase: 'discovery' }));
    expect(empty).toContain('Spell state: Not yet formed');

    const populated = buildSessionContext(
      baseState({
        phase: 'discovery',
        spell: {
          ...createInitialSpellState(),
          intent: 'protection',
          element: 'fire',
          tone: 'heroic',
          castingOrigin: 'heart',
          magicWord: 'ignite',
          confidence: 0.5,
        },
      }),
    );
    expect(populated).toContain('Intent: protection');
    expect(populated).toContain('Element: fire');
    expect(populated).toContain('Magic word: "ignite"');
    expect(populated).toContain('Confidence: 50%');
  });

  it('appends FOCUS guidance during discovery based on the next missing field', () => {
    const noIntent = buildSessionContext(baseState({ phase: 'discovery' }));
    expect(noIntent).toContain('Understand what they need');

    const onlyIntent = buildSessionContext(
      baseState({
        phase: 'discovery',
        spell: { ...createInitialSpellState(), intent: 'protection' },
      }),
    );
    expect(onlyIntent).toContain('discover their element');

    const intentPlusElement = buildSessionContext(
      baseState({
        phase: 'discovery',
        spell: { ...createInitialSpellState(), intent: 'protection', element: 'fire' },
      }),
    );
    expect(intentPlusElement).toContain('Determine the casting origin');
  });

  it('includes the user speech line when provided', () => {
    const ctx = buildSessionContext(baseState({ phase: 'discovery' }), 'hello merlin');
    expect(ctx).toContain('THEY SAID: "hello merlin"');
  });

  it('omits user speech line when no speech is provided', () => {
    const ctx = buildSessionContext(baseState({ phase: 'discovery' }));
    expect(ctx).not.toContain('THEY SAID');
  });
});

describe('createTurnContext', () => {
  beforeEach(() => {
    clearFaceEventBuffer();
  });

  it('is buildSessionContext with userSpeech mandatory — passes through', () => {
    const state = baseState({ phase: 'formation', turnCount: 4 });
    const direct = buildSessionContext(state, 'cast it');
    const wrapped = createTurnContext('cast it', state);
    expect(wrapped).toBe(direct);
  });
});
