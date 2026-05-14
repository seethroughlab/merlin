/**
 * Test Live Spell — highest-scope Test Mode entry point.
 *
 * The user free-text-describes a spell; Gemini drives the entire
 * creative process (intent/element/energy decisions, zone GLSL,
 * sprite generation) using the SAME system prompt, tool registry,
 * and dispatch live Merlin uses during a session. No parallel route.
 *
 * Pipeline:
 *   1. Build a fresh MerlinChat (live system prompt + live tools).
 *   2. Construct a TurnDispatchContext over a local SpellState
 *      accumulator (no MerlinSession instance, no MediaPipe).
 *   3. Run runMerlinTurn — same multi-call dispatch live uses.
 */

import { MerlinChat } from './gemini-chat';
import { createInitialSpellState } from './spell-state';
import { runMerlinTurn, type TurnDispatchContext } from './turn-runner';
import { emitGeminiTurn, nextTurnId } from './gemini-events';
import type {
  LiveSpellTestInput,
  LiveSpellTestResult,
} from '../../shared/types';
import type { MerlinSessionState } from './types';
import { log } from '../logger';

function buildLocalState(): MerlinSessionState {
  return {
    phase: 'formation',
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
  };
}

export async function testLiveSpell(input: LiveSpellTestInput): Promise<LiveSpellTestResult> {
  const prompt = (input.prompt ?? '').trim();
  if (!prompt) {
    return { success: false, toolCallCount: 0, error: 'Prompt is required' };
  }

  log.info('TestLiveSpell', `prompt="${prompt}"`);

  const turnId = nextTurnId();
  emitGeminiTurn({ id: turnId, source: 'test_live_spell', userPrompt: prompt });

  const state = buildLocalState();
  const ctx: TurnDispatchContext = {
    state,
    // No onRequestAnalysis: get_posture / get_expression return cached
    // (null) state with an "no data" message; Gemini stops calling them.
    // No onSpellUpdate: nothing outside the test harness needs notification.
  };

  const chat = new MerlinChat();

  try {
    chat.initChat();
    const turn = await runMerlinTurn(chat, prompt, ctx, turnId, 'test_live_spell');

    emitGeminiTurn({
      id: turnId,
      source: 'test_live_spell',
      responseText: turn.finalText || undefined,
      final: true,
    });

    return {
      success: true,
      toolCallCount: turn.toolCallCount,
      finalSpell: state.spell as unknown as Record<string, unknown>,
      finalText: turn.finalText || undefined,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error('TestLiveSpell', 'failed:', msg);
    emitGeminiTurn({
      id: turnId,
      source: 'test_live_spell',
      responseText: `Error: ${msg}`,
      final: true,
    });
    return { success: false, toolCallCount: 0, error: msg };
  }
}
