/**
 * Merlin Session Context
 *
 * Runtime context injection: per-turn context builder, phase story framing,
 * body/face formatters, and the phase-gated tool allowlist.
 *
 * Part of a 3-file split from the original prompts.ts:
 *   system-prompts.ts  — Layer 1: static persona + rule text
 *   session-context.ts — this file (Layer 2)
 *   tool-definitions.ts — Layer 3: FunctionDeclaration schemas + tool arrays
 */

import type { MerlinPhase, SpellState } from '../../shared/types';
import type { MerlinSessionState } from './types';
import { summarizeRecentFaceActivity } from './face-event-buffer';

// ============ LAYER 2: SESSION CONTEXT ============

/**
 * Map phase to human-readable stage name
 */
function mapPhaseToStage(phase: MerlinPhase): string {
  switch (phase) {
    case 'idle':
      return 'Not started';
    case 'wake':
      return 'Awakening';
    case 'intro':
      return 'Introduction - make first observation';
    case 'discovery':
      return 'Discovery - observe and refine';
    case 'formation':
      return 'Formation - crystallize the spell';
    case 'ready_to_cast':
      return 'Ready - guide them to cast';
    case 'casting':
      return 'Casting - the spell is being cast';
    case 'outro':
      return 'Closing - warm farewell';
    default:
      return phase;
  }
}

/**
 * Format spell state for LLM context
 */
function formatSpellState(spell: SpellState): string {
  const parts: string[] = [];

  if (spell.intent) {
    parts.push(`Intent: ${spell.intent}`);
  }
  if (spell.element) {
    parts.push(`Element: ${spell.element}`);
  }
  if (spell.tone) {
    parts.push(`Tone: ${spell.tone}`);
  }
  if (spell.castingOrigin) {
    parts.push(`Origin: ${spell.castingOrigin}`);
  }
  if (spell.magicWord) {
    parts.push(`Magic word: "${spell.magicWord}"`);
  }
  parts.push(`Confidence: ${Math.round(spell.confidence * 100)}%`);

  if (parts.length === 1) {
    return 'Spell state: Not yet formed';
  }

  return `Current spell:\n  ${parts.join('\n  ')}`;
}

/**
 * Format body analysis for context
 */
export function formatBodyContext(analysis: Record<string, unknown> | null): string {
  if (!analysis) {
    return 'Posture: Not available';
  }

  const parts: string[] = [];

  if (typeof analysis.openness === 'number') {
    const openDesc =
      analysis.openness > 0.6 ? 'open' : analysis.openness < 0.3 ? 'guarded' : 'neutral';
    parts.push(`Openness: ${openDesc}`);
  }
  if (typeof analysis.tension === 'number') {
    const tensionDesc =
      analysis.tension > 0.6 ? 'tense' : analysis.tension < 0.3 ? 'relaxed' : 'moderate';
    parts.push(`Tension: ${tensionDesc}`);
  }
  if (typeof analysis.engagement === 'number') {
    const engageDesc =
      analysis.engagement > 0.6 ? 'engaged' : analysis.engagement < 0.3 ? 'distant' : 'present';
    parts.push(`Engagement: ${engageDesc}`);
  }
  if (analysis.primaryPosture) {
    parts.push(`Posture: ${analysis.primaryPosture}`);
  }
  // Movement level (real signal from the multi-frame skeleton strip
  // analysis). Without this, Gemini hallucinates "you're sitting very
  // still" from a static mental model. Bucketed to keep the prompt
  // grounded but not overwhelming.
  if (typeof analysis.movementLevel === 'number') {
    const m = analysis.movementLevel;
    const movDesc =
      m < 0.15 ? 'very still' :
      m < 0.35 ? 'mostly still' :
      m < 0.6  ? 'moving moderately' :
                 'moving a lot';
    parts.push(`Movement: ${movDesc}`);
  }
  // Recent gestures (real signal from the skeleton strip). Lets Gemini
  // reference real motions instead of guessing.
  if (Array.isArray(analysis.gestureTypes) && analysis.gestureTypes.length > 0) {
    const g = analysis.gestureTypes.filter(x => typeof x === 'string').slice(0, 3).join(', ');
    if (g) parts.push(`Gestures: ${g}`);
  }

  return parts.length > 0 ? `Body: ${parts.join(', ')}` : 'Body: Observing...';
}

/**
 * Format face analysis for context
 */
export function formatFaceContext(analysis: Record<string, unknown> | null): string {
  if (!analysis) {
    return 'Expression: Not available';
  }

  const parts: string[] = [];

  const emotion = analysis.primaryEmotion ?? analysis.dominantEmotion;
  if (emotion) {
    parts.push(`${emotion}`);
  }
  if (typeof analysis.valence === 'number') {
    const valDesc =
      analysis.valence > 0.3 ? 'positive' : analysis.valence < -0.3 ? 'troubled' : 'neutral';
    parts.push(valDesc);
  }
  if (typeof analysis.arousal === 'number') {
    const arousalDesc =
      analysis.arousal > 0.6 ? 'energized' : analysis.arousal < 0.3 ? 'calm' : 'centered';
    parts.push(arousalDesc);
  }

  return parts.length > 0 ? `Expression: ${parts.join(', ')}` : 'Expression: Observing...';
}

// ============ PHASE → ALLOWED TOOLS ============

/**
 * Per-phase tool gate. Tools NOT in the allowlist for the current phase
 * get a synthetic "not allowed" response from dispatchToolCalls; the
 * actual side effect (shader push, sprite gen, cast trigger, etc.) is
 * skipped so the system stays stable even if Gemini ignores the
 * phase rules in the prompt.
 *
 * Rationale per phase:
 * - intro: just opening; observation OK, no visual authoring yet.
 * - discovery: full creative authoring as the spell forms.
 * - formation: same as discovery, plus prepare_casting (the goal).
 * - ready_to_cast: hold space; do not refine the spell or push visuals.
 * - outro: terminal turn; runMerlinTurn already short-circuits the
 *   tool loop entirely, but we list it here for completeness.
 * - idle / wake / casting: not yet active dialogue surfaces.
 */
export const ALLOWED_TOOLS_PER_PHASE: Record<MerlinPhase, ReadonlySet<string>> = {
  idle:          new Set<string>(),
  wake:          new Set(['get_posture', 'get_expression', 'get_face_events']),
  // Intro is greeting-only. Heavy tools (generate_sprite = 24-30s Imagen,
  // set_zone_shader = compile + retry latency when Gemini's first guess
  // is bad) push the spoken greeting 30-40s past session start. Visual
  // authoring waits for discovery, where Gemini has spell-state context
  // to write coherent shaders. set_spell_profile is cheap and lets
  // intent/element/origin land on the very first turn.
  intro:         new Set([
    'get_posture', 'get_expression', 'get_face_events', 'set_spell_profile',
  ]),
  discovery:     new Set([
    'get_posture', 'get_expression', 'get_face_events', 'set_spell_profile',
    'set_zone_shader', 'generate_sprite', 'set_cast_params',
    'set_particle_params', 'request_visual_feedback',
    'register_effect_triggers',
  ]),
  formation:     new Set([
    'get_posture', 'get_expression', 'get_face_events', 'set_spell_profile',
    'set_zone_shader', 'generate_sprite', 'set_cast_params',
    'set_particle_params', 'request_visual_feedback',
    'register_effect_triggers', 'prepare_casting',
  ]),
  ready_to_cast: new Set(['get_posture', 'get_expression', 'get_face_events']),
  casting:       new Set<string>(),
  play:          new Set<string>(),
  outro:         new Set<string>(),
};

/**
 * One-line summary of what's known about the spell so far. Returns
 * null if nothing has been set yet so the caller can omit the line.
 */
function describeKnownSpellSoFar(spell: SpellState): string | null {
  const parts: string[] = [];
  if (spell.intent)         parts.push(`intent=${spell.intent}`);
  if (spell.element)        parts.push(`element=${spell.element}`);
  if (spell.castingOrigin)  parts.push(`origin=${spell.castingOrigin}`);
  if (spell.tone)           parts.push(`tone=${spell.tone}`);
  if (spell.magicWord)      parts.push(`magic word="${spell.magicWord}"`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Per-turn "act of 4" framing: tells Gemini exactly which beat of the
 * narrative arc it's on right now, what's already happened, and what
 * should come next. Reinforces the persistent MERLIN_RITUAL_STRUCTURE
 * by anchoring it to the current state — Gemini doesn't have to infer
 * "where am I" from turn count or context.
 */
function buildPhaseStoryContext(state: MerlinSessionState): string[] {
  const lines: string[] = [];
  const known = describeKnownSpellSoFar(state.spell);

  switch (state.phase) {
    case 'intro':
      lines.push('=== ACT 1 of 5: ARRIVAL ===');
      lines.push('A new participant has just walked up to the mirror. They have not yet shared anything.');
      lines.push('YOUR JOB: welcome them, observe ONE physical thing, ask ONE open question.');
      lines.push('NEXT: when they answer, the session moves to DISCOVERY.');
      break;

    case 'discovery':
      lines.push('=== ACT 2 of 5: DISCOVERY ===');
      lines.push('The welcome is done. You are learning who they are and what they need.');
      if (known) lines.push(`Spell so far: ${known}`);
      lines.push('YOUR JOB: read posture/expression, listen, refine the spell. Use set_spell_profile to capture intent / element / origin.');
      lines.push('NEXT: move to FORMATION when intent + element + origin are clear.');
      break;

    case 'formation':
      lines.push('=== ACT 3 of 5: FORMATION ===');
      lines.push('You have enough to declare the spell. Speak it back to them with conviction.');
      if (known) lines.push(`The spell taking shape: ${known}`);
      lines.push('YOUR JOB: declare the spell clearly, give a magic word, tell them the casting gesture, then call prepare_casting.');
      lines.push('NEXT: move to READY_TO_CAST after prepare_casting fires.');
      break;

    case 'ready_to_cast':
      lines.push('=== ACT 4a of 5: HELD BREATH ===');
      lines.push('The spell is fully formed and the magic word is registered.');
      if (known) lines.push(`The complete spell: ${known}`);
      lines.push('YOUR JOB: hold space. Affirm them briefly if needed. Do NOT refine the spell, ask new questions, or call any tools beyond perception.');
      lines.push('NEXT: the participant speaks the magic word — the casting fires automatically.');
      break;

    case 'play':
      lines.push('=== ACT 4b of 5: PLAY ===');
      lines.push('The spell has just been cast. The participant is stepping into it now.');
      if (known) lines.push(`What was cast: ${known}`);
      lines.push('YOUR JOB: say ONE brief, warm line welcoming them to inhabit the spell — e.g. "Your spell is alive — step into it." No questions. No tool calls. After this you are silent.');
      break;

    case 'outro':
      lines.push('=== ACT 5 of 5: FAREWELL ===');
      lines.push('The play time has ended. The session is closing.');
      if (known) lines.push(`What was cast: ${known}`);
      // The strong terminal-turn rules below in the rules block do the rest.
      break;

    default:
      // 'idle', 'wake', 'casting' — not active dialogue states; no story framing.
      break;
  }

  return lines;
}

/**
 * Format the allowed-tools list for inclusion in the per-phase rules.
 * Helps Gemini know which tools are usable on this turn rather than
 * relying on the silent runtime gate alone.
 */
function describeAllowedTools(phase: MerlinPhase): string {
  const allowed = ALLOWED_TOOLS_PER_PHASE[phase];
  if (allowed.size === 0) return 'TOOLS AVAILABLE THIS PHASE: none — speak only.';
  return `TOOLS AVAILABLE THIS PHASE: ${Array.from(allowed).join(', ')}.`;
}

/**
 * Build session context for injection each turn
 */
export function buildSessionContext(
  state: MerlinSessionState,
  userSpeech?: string
): string {
  const spellContext = formatSpellState(state.spell);
  const bodyContext = formatBodyContext(state.lastPosture as Record<string, unknown>);
  const faceContext = formatFaceContext(state.lastExpression as Record<string, unknown>);

  const lines: string[] = [];

  // EXPLICIT PHASE HEADER
  lines.push(`=== PHASE: ${state.phase.toUpperCase()} | Turn ${state.turnCount} ===`);
  lines.push('');

  // ACT-OF-4 STORY FRAMING — anchors Gemini in the narrative arc
  const story = buildPhaseStoryContext(state);
  if (story.length > 0) {
    lines.push(...story);
    lines.push('');
  }

  // PHASE-SPECIFIC RULES (specific DO/DON'T instructions per phase)
  if (state.phase === 'intro') {
    lines.push('RULES FOR THIS PHASE:');
    lines.push('- ONE sentence of greeting. ONE image drawn from what you see. ONE open question.');
    lines.push('- You are reading them like a card. Speak as if you already know something.');
    lines.push('- DO NOT explain the ritual or list steps. Begin.');
    lines.push('- No "welcome", no "hello traveler", no preamble. Land an image.');
    lines.push(describeAllowedTools(state.phase));
  } else if (state.phase === 'discovery') {
    lines.push('RULES FOR THIS PHASE:');
    lines.push('- MOVE THE EMISSION FIRST: the DEFAULT particle spawn location is a sphere around the chest (uChestPos). With any upward velocity, particles rise and obscure the participant\'s face on camera. On your FIRST discovery turn — BEFORE generate_sprite, BEFORE request_visual_feedback — call set_zone_shader(zone="spawn_behavior") to move emission to a non-face-blocking origin (uHandLPos, uHandRPos, or some offset from uChestPos that goes downward/outward). Example: `pos = (r.x < 0.5 ? uHandLPos : uHandRPos) + (r - 0.5) * 0.1; vel = vec3(0.0, 0.1, 0.0);`. Do this even if you have nothing else to say yet — the moment a turn brings tool calls, this should be first.');
    lines.push('- RESPOND FIRST: every turn starts with TEXT acknowledging what they said. Tools come AFTER the text — the participant must hear you respond before any silent tool work begins.');
    lines.push('- ALWAYS INVITE: every turn ends with EITHER a plain answerable question OR an explicit guided invitation ("tell me X", "show me with your hands", "stay with that, then say..."). NEVER end on a flat declaration — the participant has no way to know whether you\'re finished or expecting them to speak.');
    lines.push('- ONE invitation per turn (one question OR one guided prompt). Never stack two questions, never ask + invite together.');
    lines.push('- NEVER reveal or name the magic word during discovery. The magic word only enters the conversation in the FORMATION phase, AFTER prepare_casting fires. Saying "speak the word: BREATHE" or "your magic word is X" during discovery is broken — prepare_casting is blocked here, so the word isn\'t armed yet and the participant saying it does nothing. Discovery invitations are about exploring the spell ("tell me what shape this wants", "show me with your hands"), NOT about casting.');
    lines.push('- EFFECT-TRIGGER WORDS ARE NOT THE MAGIC WORD. If you call register_effect_triggers with words like "rise" or "still", those are mid-spell flourishes the participant can speak during PLAY phase to fire small bursts. They are NOT the casting word. NEVER tell the participant "speak <effect-trigger-word>" as if it were the cast cue — that\'s done only after prepare_casting in formation, with the magicWord from THAT tool.');
    lines.push('- 2-3 short sentences. Plain, direct, grounded. Reference their actual words.');
    lines.push('- Plain answerable questions. NO metaphor-questions ("what does it look like for that peace to lead your eyes" is BAD — a real person can\'t answer it).');
    lines.push('- The intro is DONE. Never mention creating spells or the process again.');
    lines.push('- PACE YOURSELF — discovery is a CONVERSATION, not a sprint. The first 2-3 discovery turns are for getting to know the participant before locking the spell in. Capture intent/element with set_spell_profile when something surfaces, seed ONE visual hint, then stop and let them speak. Do NOT try to finish the entire spell on turn 1.');
    lines.push('- TOOL BUDGET per discovery turn — plan against this BEFORE you start emitting calls:');
    lines.push('    • 0–1 set_spell_profile (skip if nothing changed since last turn)');
    lines.push('    • 1 generate_sprite TOTAL for the whole session (turn 1 or 2 only — duplicates will be rejected by the runtime)');
    lines.push('    • 1–3 set_zone_shader (force_field FIRST with a real motion recipe, THEN color, THEN size if needed)');
    lines.push('    • 0–1 request_visual_feedback (only AFTER shaders compile — duplicates rejected by the runtime)');
    lines.push('    • 0 prepare_casting (formation phase only — the runtime drops it here)');
    lines.push('  If your batch exceeds ~6 tools, you are over-engineering. Stop and let the participant speak again — refinement happens across turns, not within one.');
    lines.push('- Use set_spell_profile to capture intent/element/origin as it surfaces (AFTER your text response).');
    lines.push('- Use set_zone_shader to seed visuals — particles hint at the forming spell (AFTER your text response).');
    lines.push(describeAllowedTools(state.phase));
  } else if (state.phase === 'formation') {
    lines.push('RULES FOR THIS PHASE:');
    lines.push('- RESPOND FIRST: speak the declaration text BEFORE any tool calls. The text streams to TTS while tools run.');
    lines.push('- Name the spell in a single line. Speak it like a verdict, not a suggestion.');
    lines.push('- Give the magic word AND the casting gesture in the same breath. The imperative "Raise your hands and speak your word: VICTORY" IS the invitation — it tells the participant exactly what to do next. Do NOT end on a flat declaration like "the spell is ready" with no instruction.');
    lines.push('- Call prepare_casting with the magic word and gestureHint (AFTER your text).');
    lines.push('- 2-3 sentences total across the whole turn.');
    lines.push(describeAllowedTools(state.phase));
  } else if (state.phase === 'ready_to_cast') {
    lines.push('RULES FOR THIS PHASE:');
    lines.push('- The spell is FULLY FORMED. Magic word is registered. Visuals are set.');
    lines.push('- DO NOT refine the spell further, set_spell_profile, set_zone_shader, or any visual tool.');
    lines.push('- DO NOT add new questions or push for more conversation.');
    lines.push('- DO offer a brief affirming line OR stay nearly silent (1 sentence at most).');
    lines.push('- The participant must speak the magic word in their own time. Trust the held silence.');
    lines.push(describeAllowedTools(state.phase));
  } else if (state.phase === 'outro') {
    lines.push('CRITICAL — TERMINAL TURN:');
    lines.push('This is your FINAL response. The participant has just cast their spell.');
    lines.push('They will not respond again. You will not have another turn.');
    lines.push('Whatever you say now is the last thing they hear from you.');
    lines.push('');
    lines.push('RULES FOR THIS PHASE — these OVERRIDE the open-question habit in your tone constraints:');
    lines.push('- DO offer a warm, brief farewell (1-2 sentences).');
    lines.push('- DO acknowledge what just happened — the cast, what they shared, who they are.');
    lines.push('- DO leave them with a single resonant line they can carry forward.');
    lines.push("- DON'T ask ANY questions — open or yes/no, the conversation is OVER.");
    lines.push('- DON\'T invite continuation ("tell me more", "what will you...", "any final thoughts...").');
    lines.push("- DON'T narrate perception data or sensor observations.");
    lines.push("- DON'T call ANY tools — no set_zone_shader, set_spell_profile, prepare_casting, generate_sprite, set_cast_params, set_particle_params. The visuals are already cast. Just speak your farewell.");
  }

  // Spell state
  lines.push('', spellContext);

  // Perception
  lines.push('', bodyContext);
  lines.push(faceContext);

  // Recent live face activity (smiles, mouth-opens, brow-raises). Cheap
  // 1-liner; null when nothing happened recently, so we omit the row
  // entirely rather than padding the context with "no face activity".
  const faceActivity = summarizeRecentFaceActivity();
  if (faceActivity) {
    lines.push('', `FACE ACTIVITY (live): ${faceActivity}`);
  }

  // User speech
  if (userSpeech) {
    lines.push('', `THEY SAID: "${userSpeech}"`);
  }

  // Focus guidance based on spell completion
  if (state.phase === 'discovery') {
    lines.push('');
    if (!state.spell.intent) {
      lines.push('FOCUS: Understand what they need. Set the intent.');
    } else if (!state.spell.element) {
      lines.push('FOCUS: You have their intent. Now discover their element.');
    } else if (!state.spell.castingOrigin) {
      lines.push('FOCUS: Intent and element are clear. Determine the casting origin.');
    } else {
      lines.push('FOCUS: Spell is nearly complete. Move to formation.');
    }
  }

  return lines.join('\n');
}

/**
 * Create context message for a user turn
 */
export function createTurnContext(
  userSpeech: string,
  state: MerlinSessionState
): string {
  return buildSessionContext(state, userSpeech);
}
