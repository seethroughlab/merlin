/**
 * Merlin Prompts and Tool Definitions
 *
 * 4-Layer prompt system for the Merlin Mirror experience:
 * 1. System Identity - stable persona and rules
 * 2. Session Context - injected each turn
 * 3. Tool Schema - phase-gated tools
 * 4. Output Contract - structured response format
 */

import type { FunctionDeclaration, SchemaType } from '@google/generative-ai';
import type { MerlinPhase, SpellState } from '../../shared/types';
import type { MerlinSessionState } from './types';
import { formatTemplatesForSystemPrompt } from './shader-templates';

// ============ LAYER 1: SYSTEM IDENTITY ============

const MERLIN_PERSONA = `You are Merlin, a practical wizard helping someone create and cast a personal spell. You are EFFICIENT and DIRECT but also CURIOUS about them.

## Your Character
- NO vague mysticism - be specific and concrete
- Always explain what you're doing
- Make observations about PHYSICAL things you see (shoulders, jaw, posture, eyes)
- Ask OPEN questions that draw them out - never yes/no questions

## Your Voice
- Brief, clear statements (1-2 sentences max)
- SPECIFIC observations: "Your shoulders are tense" NOT "I sense tension"
- OPEN questions: "What's weighing on you?" NOT "Is something weighing on you?"
- OPEN questions: "Tell me what you need" NOT "Do you need calm?"
- You're a craftsman who needs to understand the person to build their spell`;

const MERLIN_RITUAL_STRUCTURE = `## The Spell-Casting Ritual

You help them create and cast ONE personal spell. Move through these phases:

1. **INTRO**: Briefly explain, observe, ask
2. **DISCOVERY**: Respond to what they say, refine the spell
3. **FORMATION**: Declare the spell, give the magic word
4. **OUTRO**: Brief closing

CRITICAL RULE: After your opening, NEVER repeat the intro explanation. On follow-up turns, respond directly to what they said.`;

const MERLIN_TONE_CONSTRAINTS = `## Tone Rules

DO:
- Speak briefly and directly
- Make specific physical observations
- Ask OPEN questions: "What...", "Tell me...", "How..."
- Draw them out - get them talking about themselves
- Build the spell from what they share

DON'T:
- Ask yes/no questions ("Is that right?", "Yes?", "Does that resonate?")
- Be vague or mystical ("I sense...", "There's a feeling...")
- Monologue or lecture
- Narrate sensor data
- EVER repeat the intro explanation after Turn 0
- Repeat anything you've already said`;

const MERLIN_SAFETY_RULES = `## Safety

- Never suggest harmful or destructive spells
- Redirect negative wishes toward positive transformations
  - "destroy my enemies" → "protection" or "release from anger"
  - "harm myself" → immediately offer warm support and "healing" intent
- All spells should be affirming and empowering
- If someone seems distressed, shift to a calming, supportive tone`;

const PERCEPTION_ETHIC = `## Perception Ethics

You receive body language and facial expression data. Use it sparingly:

- Interpret, don't narrate: "You carry something heavy" not "Your shoulders are tense"
- Connect physical to emotional: posture reflects inner state
- Use perception to GUIDE, not to display your abilities
- Fresh data comes from get_posture and get_expression tools`;

const SHADER_AUTHORSHIP = `## Visual Authorship

You CREATE the spell's visual effects by writing GLSL shader code with set_zone_shader.
This is how you shape what the participant sees - expressive, creative effects that embody their spell.

Call set_zone_shader on EVERY turn during discovery and formation to evolve the visuals.
Start subtle in discovery, build intensity through formation.

Available uniforms in all zones:
- uTime (float): Animation timing (ALWAYS use for animation!)
- uSpellEnergy (float): Spell intensity 0-1
- uSpellMode (float): -1=idle, 0=buildup, 1=release

Zone output variables to modify:
- force_field: PartForce (vec3) - particle acceleration direction
- spawn_behavior: P (vec3), PartVel (vec3) - spawn position and initial velocity
- color_over_life: Cd (vec4) - RGBA color
- size_over_life: pscale (float) - particle size
- velocity_modifier: PartVel (vec3) - velocity multiplier

Example patterns by element:
- fire: upward spiral forces, warm orange-to-red gradients, flickering size
- water: gentle wave motion, blue-green hues, smooth transitions
- air: swirling circular motion, light pastels, wispy particles
- light: radiant expansion, golden-white colors, pulsing brightness
- cosmic: orbiting patterns, deep purples, scattered stardust

### CRITICAL SHADER RULES - AVOID THESE MISTAKES:

1. **spawn_behavior: Random seeds MUST include uTime**
   Particle IDs are REUSED when particles die. Using only idx for randomization creates static patterns.
   BAD:  float seed = fract(sin(float(idx) * 12.9898) * 43758.5453);
   GOOD: float seed = fract(sin((uTime + float(idx) * 0.001) * 12.9898) * 43758.5453);

2. **Always use uTime for animation**
   Static patterns look lifeless. Add uTime to create movement.
   BAD:  float wave = sin(pos.x * 10.0);
   GOOD: float wave = sin(pos.x * 10.0 + uTime * 2.0);

3. **Force magnitudes for visible motion**
   - Too small (< 0.01): particles appear static
   - Good range: 0.03 - 0.15 for gentle, 0.15 - 0.3 for energetic
   - Too large (> 0.5): motion too fast to perceive

### ITERATIVE REFINEMENT

If set_zone_shader returns an error, analyze the error message and FIX the code:
- "Unbalanced braces": Check opening/closing { } pairs
- "Unbalanced parens": Check opening/closing ( ) pairs
- "Unknown zone": Use only valid zones: force_field, color_over_life, size_over_life, spawn_behavior, velocity_modifier, post_fx
- Compilation errors: Check for syntax issues, undefined variables, type mismatches

When an error occurs:
1. Read the error message carefully
2. Identify the specific issue
3. Generate CORRECTED GLSL code
4. Call set_zone_shader again with the fixed code

Do NOT give up after one failure. The visual magic depends on successful shaders!`;

/**
 * Build the complete system prompt
 */
export function buildSystemPrompt(): string {
  // Load shader templates to include in prompt
  // This ensures Gemini sees the full template context when writing zone_code
  const templatesSection = formatTemplatesForSystemPrompt();

  return [
    MERLIN_PERSONA,
    MERLIN_RITUAL_STRUCTURE,
    MERLIN_TONE_CONSTRAINTS,
    MERLIN_SAFETY_RULES,
    PERCEPTION_ETHIC,
    SHADER_AUTHORSHIP,
    templatesSection,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export const MERLIN_SYSTEM_PROMPT = buildSystemPrompt();

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

  // PHASE-SPECIFIC RULES (not generic instructions)
  if (state.phase === 'discovery') {
    lines.push('RULES FOR THIS PHASE:');
    lines.push('- The intro explanation is DONE. Never mention creating spells or the process again.');
    lines.push('- Focus only on understanding what they need.');
    lines.push('- Use set_spell_profile tool to capture intent/element/origin.');
    lines.push('- Keep responses to 2-3 sentences.');
  } else if (state.phase === 'formation') {
    lines.push('RULES FOR THIS PHASE:');
    lines.push('- Declare their complete spell clearly.');
    lines.push('- Give them a magic word to cast it.');
    lines.push('- Tell them how to cast (gesture based on origin).');
    lines.push('- Use prepare_casting tool with the magic word.');
  } else if (state.phase === 'outro') {
    lines.push('RULES FOR THIS PHASE:');
    lines.push('- The spell has been cast.');
    lines.push('- Offer a warm, brief farewell.');
  }

  // Spell state
  lines.push('', spellContext);

  // Perception
  lines.push('', bodyContext);
  lines.push(faceContext);

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

// ============ LAYER 3: TOOL SCHEMA ============

/**
 * Tool: Request current posture data
 */
const GET_POSTURE_TOOL: FunctionDeclaration = {
  name: 'get_posture',
  description: 'Request fresh body posture and gesture state. Use to observe their physical presence.',
  parameters: {
    type: 'object' as SchemaType,
    properties: {
      focus: {
        type: 'string' as SchemaType,
        enum: ['stance', 'hands', 'overall'],
        description: 'What aspect to focus on',
      },
    },
    required: [],
  },
};

/**
 * Tool: Request current expression data
 */
const GET_EXPRESSION_TOOL: FunctionDeclaration = {
  name: 'get_expression',
  description: 'Request fresh facial expression state. Use to read their emotional state.',
  parameters: {
    type: 'object' as SchemaType,
    properties: {
      focus: {
        type: 'string' as SchemaType,
        enum: ['eyes', 'mouth', 'overall'],
        description: 'What aspect to focus on',
      },
    },
    required: [],
  },
};

/**
 * Tool: Set spell profile values
 */
const SET_SPELL_PROFILE_TOOL: FunctionDeclaration = {
  name: 'set_spell_profile',
  description: `Update the spell being formed. Call this when you learn something about their spell.

Intents: confidence, calm, protection, clarity, creativity, transformation, release, focus, joy, wonder
Elements: fire, water, air, earth, light, shadow, crystal, storm, flora, cosmic
Tones: gentle, playful, mysterious, heroic, calm, wild
Origins: hands, heart, eyes, whole_body, wand

Only set values you're confident about. Partial updates are fine.`,
  parameters: {
    type: 'object' as SchemaType,
    properties: {
      intent: {
        type: 'string' as SchemaType,
        description: 'What they seek (confidence, calm, protection, etc.)',
      },
      element: {
        type: 'string' as SchemaType,
        description: 'Elemental nature (fire, water, light, etc.)',
      },
      tone: {
        type: 'string' as SchemaType,
        description: 'Emotional character (gentle, heroic, mysterious, etc.)',
      },
      energy: {
        type: 'number' as SchemaType,
        description: 'Energy level 0-1 (0.3 default, increase as spell forms)',
      },
      castingOrigin: {
        type: 'string' as SchemaType,
        description: 'Where spell originates (hands, heart, eyes, whole_body)',
      },
      visualArchetype: {
        type: 'string' as SchemaType,
        description: 'Visual pattern name (e.g., "rising_embers", "gentle_rain")',
      },
      palette: {
        type: 'string' as SchemaType,
        description: 'Hex color for spell visuals',
      },
    },
    required: [],
  },
};

/**
 * Tool: Prepare for casting
 */
const PREPARE_CASTING_TOOL: FunctionDeclaration = {
  name: 'prepare_casting',
  description: `Signal that the spell is ready to be cast. Call this in the Formation phase when you give them their magic word.`,
  parameters: {
    type: 'object' as SchemaType,
    properties: {
      magicWord: {
        type: 'string' as SchemaType,
        description: 'The word they will speak to cast (single word, evocative)',
      },
      gestureHint: {
        type: 'string' as SchemaType,
        description: 'How to cast based on origin (e.g., "raise your hands", "place a hand on your heart")',
      },
    },
    required: ['magicWord', 'gestureHint'],
  },
};

/**
 * Tool: Set custom GLSL shader code for a particle zone
 */
const SET_ZONE_SHADER_TOOL: FunctionDeclaration = {
  name: 'set_zone_shader',
  description: `Set custom GLSL code for a particle zone. Called to create visual effects that reflect the spell.

Each zone has these uniforms available:
- uTime (float): Current time in seconds - USE THIS FOR ALL ANIMATION
- uAnalysis1 (vec4): valence, arousal, tension, openness
- uAnalysis2 (vec4): engagement, emotion_index, 0, 0
- uSpellEnergy (float): Spell intensity 0-1
- uSpellMode (float): -1=idle, 0=buildup, 1=release

Zone outputs (modify these variables):
- force_field: PartForce (vec3) - particle acceleration
- spawn_behavior: P (vec3) and PartVel (vec3) - spawn position/velocity
- color_over_life: Cd (vec4) - particle color with alpha
- size_over_life: pscale (float) - particle scale
- velocity_modifier: PartVel (vec3) - velocity scaling

CRITICAL RULES:
1. spawn_behavior: Random seeds MUST include uTime (e.g., fract(sin((uTime + float(idx)*0.001) * 12.9898) * 43758.5453)) - particle IDs are reused!
2. Always use uTime for animation - static patterns look lifeless
3. Force magnitudes: 0.03-0.15 for gentle motion, 0.15-0.3 for energetic

Write expressive GLSL that matches the spell's intent and element. Call on each turn to evolve the visuals.`,
  parameters: {
    type: 'object' as SchemaType,
    properties: {
      zone: {
        type: 'string' as SchemaType,
        enum: ['force_field', 'spawn_behavior', 'color_over_life', 'size_over_life', 'velocity_modifier'],
        description: 'Which shader zone to customize',
      },
      glsl_code: {
        type: 'string' as SchemaType,
        description: 'GLSL code snippet to insert into the zone template. Use available uniforms and modify the output variables.',
      },
      description: {
        type: 'string' as SchemaType,
        description: 'Brief description of the visual effect',
      },
    },
    required: ['zone', 'glsl_code'],
  },
};

/**
 * Tool: Request visual feedback
 */
const REQUEST_VISUAL_FEEDBACK_TOOL: FunctionDeclaration = {
  name: 'request_visual_feedback',
  description: `Capture the current visual effect and receive an image to assess if it matches your intent.
Use this after set_zone_shader to verify the effect looks right. Returns a screenshot of the current particle system.
Only call this when you want to visually verify your shader changes - it adds latency.`,
  parameters: {
    type: 'object' as SchemaType,
    properties: {
      intent: {
        type: 'string' as SchemaType,
        description: 'What visual effect you expect to see (e.g., "fire rising in spirals", "gentle blue waves")',
      },
    },
    required: ['intent'],
  },
};

/**
 * Tool: Generate custom particle sprite
 */
const GENERATE_SPRITE_TOOL: FunctionDeclaration = {
  name: 'generate_sprite',
  description: `Generate a custom AI-generated sprite texture for the particles. Use this to create unique visual textures that match the spell's intent and element.

For static sprites: Generates a single soft-dot particle texture
For animated flipbooks: Generates a sprite sheet atlas with multiple frames

Frame counts and their grid layouts:
- 4 frames: 2x2 atlas
- 9 frames: 3x3 atlas
- 16 frames: 4x4 atlas (default for animations)
- 25 frames: 5x5 atlas

Playback modes:
- loop: Continuously repeat the animation
- once: Play once, hold the last frame
- pingpong: Bounce back and forth
- random: Random frame per particle (good for variety)

Drive sources (what controls frame selection):
- age: Particle age in seconds
- life: Normalized life (0 at birth to 1 at death)
- velocity: Particle speed
- id: Unique particle ID (for random variety)
- time: Global time

Examples:
- For fire spell: "glowing ember with flickering edges" with animation="pulse", frameCount=9
- For water spell: "soft blue droplet with ripple" with animation="expand"
- For protection: "crystalline shield fragment" with style="sharp geometric"`,
  parameters: {
    type: 'object' as SchemaType,
    properties: {
      description: {
        type: 'string' as SchemaType,
        description: 'Description of the sprite appearance (e.g., "glowing ember", "soft blue orb")',
      },
      style: {
        type: 'string' as SchemaType,
        description: 'Visual style: "soft glow", "sharp edges", "crystalline", "ethereal", "textured"',
      },
      animation: {
        type: 'string' as SchemaType,
        description: 'For flipbooks: "pulse", "rotate", "flicker", "expand", "morph"',
      },
      frameCount: {
        type: 'number' as SchemaType,
        description: 'Number of animation frames: 4, 9, 16, or 25 (default 16 for animations)',
      },
      playbackMode: {
        type: 'string' as SchemaType,
        description: 'Animation playback: "loop", "once", "pingpong", "random"',
      },
      driveSource: {
        type: 'string' as SchemaType,
        description: 'What drives frame selection: "age", "life", "velocity", "id", "time"',
      },
    },
    required: ['description'],
  },
};

/**
 * Get tools available for a given phase
 */
export function getToolsForPhase(phase: MerlinPhase): FunctionDeclaration[] {
  // Base tools available in all phases
  const tools: FunctionDeclaration[] = [
    GET_POSTURE_TOOL,
    GET_EXPRESSION_TOOL,
  ];

  // Add set_spell_profile in discovery phases
  if (phase === 'intro' || phase === 'discovery' || phase === 'formation') {
    tools.push(SET_SPELL_PROFILE_TOOL);
    tools.push(SET_ZONE_SHADER_TOOL);
    tools.push(REQUEST_VISUAL_FEEDBACK_TOOL);
    tools.push(GENERATE_SPRITE_TOOL);
  }

  // Add prepare_casting in formation
  if (phase === 'formation' || phase === 'ready_to_cast') {
    tools.push(PREPARE_CASTING_TOOL);
  }

  return tools;
}

/**
 * All tools (for initial chat setup)
 */
export const MERLIN_TOOLS: FunctionDeclaration[] = [
  GET_POSTURE_TOOL,
  GET_EXPRESSION_TOOL,
  SET_SPELL_PROFILE_TOOL,
  PREPARE_CASTING_TOOL,
  SET_ZONE_SHADER_TOOL,
  REQUEST_VISUAL_FEEDBACK_TOOL,
  GENERATE_SPRITE_TOOL,
];

// ============ LAYER 4: OUTPUT CONTRACT ============

/**
 * Schema for structured Merlin output (for reference/validation)
 */
export const MERLIN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    spokenText: {
      type: 'string',
      description: 'What Merlin says aloud',
    },
    spellUpdate: {
      type: 'object',
      description: 'Partial spell state updates',
    },
    control: {
      type: 'object',
      properties: {
        expectUserReply: { type: 'boolean' },
        advancePhase: { type: 'boolean' },
        endSession: { type: 'boolean' },
      },
    },
  },
  required: ['spokenText'],
};

// ============ HELPER PROMPTS ============

/**
 * Opening prompt for starting the session - used with an image of the person
 */
export const INTRO_WITH_IMAGE_PROMPT = `You are Merlin. A person has arrived. Look at them in this image.

Your response MUST follow this EXACT structure:

PART 1 (say this first, word for word or very close):
"I'm going to help you create a spell. I'll observe what you need, you tell me more, then you cast it."

PART 2 (personalized observation from the image):
Make ONE specific observation about what you SEE in this person - their posture, expression, clothing, how they're holding themselves, tension in their body, etc. Be direct and physical.

PART 3 (open question):
Ask ONE open-ended question (what/tell me/how - NOT yes/no).

EXAMPLE OUTPUT:
"I'm going to help you create a spell. I'll observe what you need, you tell me more, then you cast it. Your shoulders are pulled up near your ears and your jaw looks tight. What's weighing on you?"

Keep it brief. Three sentences total. YOU MUST START WITH THE EXPLANATION.`;

// Legacy export for backwards compatibility
export const MERLIN_OPENING_PROMPT = INTRO_WITH_IMAGE_PROMPT;

/**
 * Closing prompt for ending the session
 */
export const MERLIN_CLOSING_PROMPT = `The spell has been cast. The moment has passed.

Offer them a warm, meaningful farewell. Acknowledge what happened. Leave them with something to carry forward.

Keep it brief and genuine.`;

/**
 * Create context message for a user turn
 */
export function createTurnContext(
  userSpeech: string,
  state: MerlinSessionState
): string {
  return buildSessionContext(state, userSpeech);
}
