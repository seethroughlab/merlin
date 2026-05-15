/**
 * Merlin Tool Definitions
 *
 * All Gemini FunctionDeclaration schemas for the Merlin spell-casting experience,
 * plus the MERLIN_TOOLS and MERLIN_VISUAL_AUTHOR_TOOLS arrays consumed by
 * gemini-chat.ts and the merlin/index.ts barrel.
 *
 * Part of a 3-file split from the original prompts.ts:
 *   system-prompts.ts  — Layer 1: static persona + rule text
 *   session-context.ts — Layer 2: per-turn runtime context injection
 *   tool-definitions.ts — this file (Layer 3)
 */

import { Type, type FunctionDeclaration } from '@google/genai';

// ============ LAYER 3: TOOL SCHEMA ============

/**
 * Tool: Request current posture data
 */
const GET_POSTURE_TOOL: FunctionDeclaration = {
  name: 'get_posture',
  description: 'Request fresh body posture and gesture state. Use to observe their physical presence.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      focus: {
        type: Type.STRING,
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
    type: Type.OBJECT,
    properties: {
      focus: {
        type: Type.STRING,
        enum: ['eyes', 'mouth', 'overall'],
        description: 'What aspect to focus on',
      },
    },
    required: [],
  },
};

/**
 * Tool: Query live face-gesture events.
 *
 * Different from get_expression (which is a slow Gemini-vision call
 * giving emotion labels). This one reads from a real-time edge-detected
 * buffer that the renderer fills from MediaPipe FaceLandmarker
 * blendshapes — instant access to "did they just smile?", "is their
 * mouth open right now?", etc. The session context already injects a
 * brief summary, so use this tool when you want more detail (exact
 * timing, scores, specific recent events).
 */
const GET_FACE_EVENTS_TOOL: FunctionDeclaration = {
  name: 'get_face_events',
  description: `Query recent live facial gesture events (mouth_open, smile, brow_raise, eye_closed). Edge-triggered — each event has 'start' or 'end' edge with a timestamp and intensity score. Renderer detects these from the live webcam at ~30fps via MediaPipe FaceLandmarker blendshapes; results are immediate (no Gemini-vision round-trip).

Use to react to fleeting expressions ("you just smiled when I said that"), check for engagement ("are they smiling right now?"), or time things to gestures. The per-turn session context already shows a brief FACE ACTIVITY line; call this tool only when you want exact timing or more events than the summary shows.`,
  parameters: {
    type: Type.OBJECT,
    properties: {
      sinceMs: {
        type: Type.NUMBER,
        description: 'How far back to query (milliseconds). Default 5000 (5 seconds). Max practical value ~30000.',
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
  description: `Tag the spell with its emerging metadata as you learn about it. This is a passive context tracker — calling it does NOT change visuals on its own. Visuals come from set_zone_shader and generate_sprite. This tool exists so future turns of the conversation know what kind of spell is forming (intent, element, energy, tone, origin) and can write GLSL that reflects it.

Intents (pick the one that matches THEIR energy, not the most common one): joy, wonder, creativity, confidence, transformation, focus, clarity, release, protection, calm
Elements: fire, water, air, earth, light, shadow, crystal, storm, flora, cosmic
Tones: playful, heroic, wild, mysterious, gentle, calm
Origins: hands, heart, eyes, whole_body, wand

PARAM-NAME RULE: use \`castingOrigin\` (not \`origin\`) for the field. The tool will silently ignore calls that pass \`origin\` — they do nothing.

ORIGIN / SHADER CONSISTENCY: castingOrigin is a tag. It does NOT move particles. The spawn_behavior shader is what controls actual particle emission. If you set castingOrigin to "eyes", you MUST also write spawn_behavior to use uEyeLPos/uEyeRPos — otherwise the visual will contradict the metadata and confuse downstream code. Same for "hands" (uHandLPos/uHandRPos), "heart" (uChestPos with downward offset), and "whole_body" (multiple anchors). Pick the origin AFTER deciding the spawn shader, so they stay aligned.

Only set values you're confident about. Partial updates are fine.`,
  parameters: {
    type: Type.OBJECT,
    properties: {
      intent: {
        type: Type.STRING,
        description: 'What they seek (confidence, calm, protection, etc.)',
      },
      element: {
        type: Type.STRING,
        description: 'Elemental nature (fire, water, light, etc.)',
      },
      tone: {
        type: Type.STRING,
        description: 'Emotional character (gentle, heroic, mysterious, etc.)',
      },
      energy: {
        type: Type.NUMBER,
        description: 'Energy level 0-1 (0.3 default, increase as spell forms)',
      },
      castingOrigin: {
        type: Type.STRING,
        description: 'Where spell originates (hands, heart, eyes, whole_body). MUST match what the spawn_behavior shader actually does — if you set "eyes", your spawn_behavior must use uEyeLPos/uEyeRPos.',
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
    type: Type.OBJECT,
    properties: {
      magicWord: {
        type: Type.STRING,
        description: 'The word they will speak to cast (single word, evocative)',
      },
      gestureHint: {
        type: Type.STRING,
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
- uSpellEnergy (float): Spell intensity 0-1
- uSpellMode (float): -1=idle, 0=buildup, 1=release

Zone locals to modify (the template writes them to the right output buffer after your snippet — do NOT write to P[], PartVel[], PartForce[], xcolor[], or xscale[] yourself):
- force_field: modify \`force\` (vec3). Auto-scaled by (0.5 + uSpellEnergy) before being written to PartForce.
- spawn_behavior: assign to \`pos\` and/or \`vel\` (vec3). Use the provided \`r\` (vec3 from hash31(id)) for randomness — do NOT redeclare it.
- color_over_life: modify \`color\` (vec4) — RGBA, alpha drives visibility.
- size_over_life: modify \`size\` (float) — scalar scale.
- velocity_modifier: modify \`vel\` (vec3) — typically multiplicative (drag, swirl).

CRITICAL RULES:
1. Per-particle randomness: use the provided hash31(id) function (returns a vec3) — id = float(TDIn_PartId()) is the persistent particle id. Do NOT use fract(sin(...)) — it aliases for sequential ids and produces clustered emergent attractors. Use id (persistent across life) NOT idx (slot index, gets recycled).
2. force_field has no default forces — your snippet is the sole source of spell motion. Final force is auto-scaled by (0.5 + uSpellEnergy).
3. Always use uTime for animation - static patterns look lifeless.
4. Force magnitudes: 0.1–0.4 for visible motion under default drag. Below 0.1 is invisible — the cloud-of-particles failure mode.

START WITH force_field. Before color or size, write a force_field snippet from one of the MOTION RECIPES in the system prompt (SPIRAL, FOUNTAIN, VORTEX, EYE-BURST, MAGNET, REPEL, HELIX). The MOTION is what makes a spell feel like a spell — a bright cloud with no motion still looks like a cloud. Pick the recipe whose shape matches the metaphor (e.g. "from my eyes" → EYE-BURST), copy the snippet, change the body uniform and K to taste.

Write expressive GLSL that matches the spell's intent and element. Call on each turn to evolve the visuals.`,
  parameters: {
    type: Type.OBJECT,
    properties: {
      zone: {
        type: Type.STRING,
        enum: ['force_field', 'spawn_behavior', 'color_over_life', 'size_over_life', 'velocity_modifier'],
        description: 'Which shader zone to customize',
      },
      glsl_code: {
        type: Type.STRING,
        description: 'GLSL code snippet to insert into the zone template. Use available uniforms and modify the output variables.',
      },
      description: {
        type: Type.STRING,
        description: 'Brief description of the visual effect',
      },
    },
    required: ['zone', 'glsl_code'],
  },
};

/**
 * Tool: Register effect-trigger words
 *
 * Lets Merlin hand the participant a few "command words" — short keywords
 * they can speak during the experience to fire an instant visual effect.
 * Matched LOCALLY in session.processUserSpeech (no Gemini round-trip),
 * so latency from utterance to effect drops from ~1-2s to ~400ms.
 */
const REGISTER_EFFECT_TRIGGERS_TOOL: FunctionDeclaration = {
  name: 'register_effect_triggers',
  description: `Hand the participant 1-3 short "command words" they can speak DURING the spell to fire instant visual flourishes (NOT the cast trigger — that's prepare_casting + magic_word). Each effect-trigger word maps to a single zone update with GLSL you write. Matched LOCALLY — no Gemini round-trip — so the effect lands in ~400ms instead of ~1-2s.

Effect triggers are mid-spell embellishments — "speak 'rise' to lift the embers, 'still' to slow them down". They are NOT the casting magic word. NEVER refer to an effect-trigger word as "your magic word" or "the word that will cast your spell" — that confuses the participant. The casting magic word is set ONLY by prepare_casting in the formation phase, and ONLY then should you tell them to speak it.

Use sparingly: 1-3 triggers is enough. Narrate them so the participant knows the words exist. Calling this tool again REPLACES the full trigger set.`,
  parameters: {
    type: Type.OBJECT,
    properties: {
      triggers: {
        type: Type.ARRAY,
        description: 'List of 1-3 trigger word → zone update mappings.',
        items: {
          type: Type.OBJECT,
          properties: {
            word: {
              type: Type.STRING,
              description: 'The keyword or short phrase the participant speaks. Lowercase, 1-2 words. No punctuation.',
            },
            zone: {
              type: Type.STRING,
              enum: ['force_field', 'spawn_behavior', 'color_over_life', 'size_over_life', 'velocity_modifier'],
              description: 'Which zone the GLSL applies to when the word fires.',
            },
            glsl_code: {
              type: Type.STRING,
              description: 'GLSL snippet to inject into the zone template — same format and constraints as set_zone_shader.',
            },
            description: {
              type: Type.STRING,
              description: 'Brief description of the effect (for logs / sidebar).',
            },
          },
          required: ['word', 'zone', 'glsl_code'],
        },
      },
    },
    required: ['triggers'],
  },
};

/**
 * Tool: Request visual feedback
 */
const REQUEST_VISUAL_FEEDBACK_TOOL: FunctionDeclaration = {
  name: 'request_visual_feedback',
  description: `Capture THREE screenshots across an energy envelope (idle / peak / afterglow) so you can evaluate the spell at multiple states, not just one frozen moment. CALL THIS after you've written a coherent batch of zone shaders (typically 2+ writes for the current spell direction) to verify the visual matches your intent. Shaders compiling cleanly is NOT proof they look right — particles can be invisible, the wrong color, the wrong shape, or stuck at the spawn point even when the GLSL compiles.

The system internally:
1. Captures FRAME A (idle) — baseline before cast, low energy.
2. Forces a fast test cast envelope and triggers spell_cast.
3. Waits ~600ms for the energy tween to converge near peak.
4. Captures FRAME B (peak) — mid-cast, maximum energy.
5. Restores idle and waits ~400ms for partial decay.
6. Captures FRAME C (afterglow) — energy mid-fade.

Treat all three frames as ground truth. Per-frame evaluation criteria:
- IDLE must show particles present and positioned correctly. If empty, your spawn_behavior or particle_params is broken — even a quiet spell should have visible particles at rest.
- PEAK must meet visible_particles >= 50, avg_brightness >= 0.02, render_vs_webcam_diff >= 0.01 AND show meaningful change from idle. If peak looks identical to idle, energy modulation isn't reaching the visuals — check whether your zone code reads uSpellEnergy.
- AFTERGLOW must show graceful fade, not an abrupt cutoff. Particles should still be visible but dimmer/sparser than peak. If afterglow is identical to peak, the cast isn't releasing; if identical to idle, the fall is too fast (rare).

Metrics in the response reflect post-peak / early-afterglow state — use them as quantitative ground truth alongside the visual comparison. The cast envelope used here is fixed (riseMs=600, fallMs=800) so timing is predictable regardless of any set_cast_params you configured for live performance feel.

Don't call this after every single shader write (wastes ~1.5s per call) — call it once per coherent batch. Adds ~1.5s of latency.`,
  parameters: {
    type: Type.OBJECT,
    properties: {
      intent: {
        type: Type.STRING,
        description: 'What visual effect you expect to see across the three frames (e.g., "fire rising in spirals at peak, embers drifting at idle and afterglow")',
      },
    },
    required: ['intent'],
  },
};

/**
 * Tool: Generate custom particle sprite
 */
export const GENERATE_SPRITE_TOOL: FunctionDeclaration = {
  name: 'generate_sprite',
  description: `Generate a custom AI-generated sprite texture for the particles. Use this to create unique visual textures that match the spell's intent and element.

For static sprites: Generates a single soft-dot particle texture
For animated flipbooks: Generates a sprite sheet atlas with multiple frames

Frame counts and their grid layouts:
- 4 frames: 2x2 atlas
- 8 frames: 4x2 atlas
- 9 frames: 3x3 atlas
- 12 frames: 4x3 atlas
- 16 frames: 4x4 atlas (default for animations)

Frame count vs detail trade-off: the shader smoothly interpolates between adjacent frames at runtime, so fewer frames at higher per-frame detail is now usually preferable to more frames with less detail. Choose 4-8 frames for slow morphs and pulses, 9-12 for medium-tempo motion, 16 only when the animation has many distinct stages.

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
- For protection: "crystalline shield fragment" with style="sharp geometric"

Response includes \`palette: [{r,g,b}, {r,g,b}]\` — two normalized RGB colors extracted from the saved sprite (primary first, accent second). Use these in subsequent set_zone_shader calls so per-particle colors match the sprite. The same colors are also bound to uSpriteColor1/uSpriteColor2 vec3 uniforms (available in color_over_life / size_over_life / billboard_pixel zones), so zone code can either reference those uniforms or hard-code the exact RGB values from the response.`,
  parameters: {
    type: Type.OBJECT,
    properties: {
      description: {
        type: Type.STRING,
        description: 'Description of the sprite appearance (e.g., "glowing ember", "soft blue orb")',
      },
      style: {
        type: Type.STRING,
        description: 'Visual style: "soft glow", "sharp edges", "crystalline", "ethereal", "textured"',
      },
      animation: {
        type: Type.STRING,
        description: 'For flipbooks: "pulse", "rotate", "flicker", "expand", "morph"',
      },
      frameCount: {
        type: Type.NUMBER,
        description: 'Number of animation frames: 4, 8, 9, 12, or 16 (default 16). Fewer frames means more detail per frame; the shader interpolates between frames so smoothness is preserved.',
      },
      playbackMode: {
        type: Type.STRING,
        description: 'Animation playback: "loop", "once", "pingpong", "random"',
      },
      driveSource: {
        type: Type.STRING,
        description: 'What drives frame selection: "age", "life", "velocity", "id", "time"',
      },
    },
    required: ['description'],
  },
};

/**
 * Tool: Configure the energy tween envelope for the current spell.
 *
 * The shader uniform `uSpellEnergy` is driven by a TD-side LagCHOP
 * smoothing the mode signal (-1 idle, 0 buildup, +1 release). This
 * tool tunes that lag's rise/fall speed and the peak value at release,
 * so the energy envelope matches the spell's character.
 *
 * Set-and-forget per spell — call once when the spell's character is
 * established; no need to repeat each turn.
 */
export const SET_CAST_PARAMS_TOOL: FunctionDeclaration = {
  name: 'set_cast_params',
  description: `Configure the energy tween envelope for this spell. Affects how uSpellEnergy rises and falls in TD over time, which in turn modulates any shader code that reads it (force scale, color brightness, particle size, etc).

The energy signal in TD is a smoothed lag of the mode (-1 idle, 0 buildup, +1 release). This tool tunes that lag's timing and peak value to match the spell's character.

Examples:
- Gentle drift / meditation spell: { riseMs: 2000, fallMs: 3000 } — slow, contemplative envelope
- Explosive lightning / striking spell: { riseMs: 150, fallMs: 600, peakEnergy: 1.0 } — snap to peak, decay fast
- Breathing / pulsing aura: { riseMs: 800, fallMs: 800, peakEnergy: 0.5 } — subtle oscillation, low ceiling
- Fire flicker: { riseMs: 300, fallMs: 1500 } — quick ignition, lingering afterglow

Defaults: riseMs=600, fallMs=800, peakEnergy=1.0. Call once per spell after you've decided its tone; don't tweak every turn.`,
  parameters: {
    type: Type.OBJECT,
    properties: {
      riseMs: {
        type: Type.NUMBER,
        description: 'Idle → peak energy lag duration in milliseconds. Smaller = sharper attack. Default 600.',
      },
      fallMs: {
        type: Type.NUMBER,
        description: 'Peak → idle decay duration in milliseconds. Smaller = faster decay; larger = lingering afterglow. Default 800.',
      },
      peakEnergy: {
        type: Type.NUMBER,
        description: 'Maximum energy at release (0–1). Lower values produce a gentler, less-intense spell. Default 1.0.',
      },
    },
  },
};

/**
 * Tool: Configure the particle simulation parameters for the current spell.
 *
 * Where set_zone_shader shapes per-particle behavior (forces, color, size)
 * and set_cast_params shapes the energy envelope, this tool controls the
 * raw simulation: how many particles exist, how long they live, how fast
 * they're born, how spread they are at birth, and whether they blend
 * additively (light) or alpha (opaque physical objects).
 *
 * Call before or alongside set_zone_shader. All fields optional — only
 * supplied keys take effect; absent ones keep current values.
 */
export const SET_PARTICLE_PARAMS_TOOL: FunctionDeclaration = {
  name: 'set_particle_params',
  description: `Configure the particle simulation: density, lifespan, emit rate, spawn spread, and blend mode. Match the numbers to the spell's character — a single candle flame and a blizzard should not look equally dense by default.

Archetype guidance:
- Dense atmospheric (fog, snow, smoke): high maxCount (1500-3000), moderate emitRate (200-400), longer lifespan (5-8s)
- Energetic / explosive (fire burst, lightning crackle): high emitRate (300-600), short lifespan (1-2s) for fast churn rather than density buildup
- Sparse precise (single candle flame, glowing rune): low maxCount (50-200), low emitRate (30-80), short lifespan (1-3s)
- Ambient drifting (stardust, pollen, embers): low emitRate (30-100), long lifespan (5-8s), wide spawnRadius

Blend mode is the most impactful parameter for non-emissive spells:
- 'additive' (default): particles sum brightness — correct for fire, light, plasma, energy. Brighter where they overlap.
- 'alpha': particles occlude each other and read as solid objects — correct for crystal, earth, shadow, flora. Use this when the particles are meant to look like physical fragments rather than emitted light.

spawnRadius controls the initial sphere of scatter around the body-tracked anchor (chest/eyes/hands). Distinct from spawn_behavior zone code which redirects which body part the spawn anchors to — radius controls the spread, zone code controls the location.

Note on maxCount vs emitRate: maxCount is a hard ceiling. If emitRate * lifespan stays under maxCount, the cap never engages — emitRate alone determines the steady-state count. Use maxCount to clamp dense effects; tune emitRate for the perceived rate of churn.

Defaults (BASELINE applied at every spell reset): maxCount=500, lifespan=4.0, emitRate=120, spawnRadius=0.2, blendMode='additive'. Call before set_zone_shader, not after request_visual_feedback.`,
  parameters: {
    type: Type.OBJECT,
    properties: {
      maxCount: {
        type: Type.NUMBER,
        description: 'Max live particles at once. Suggested 100-3000. Default 500.',
      },
      lifespan: {
        type: Type.NUMBER,
        description: 'Particle lifetime in seconds. Suggested 1.0-8.0. Default 4.0.',
      },
      emitRate: {
        type: Type.NUMBER,
        description: 'Newly-born particles per second. Suggested 30-600. Default 120.',
      },
      spawnRadius: {
        type: Type.NUMBER,
        description: 'Spawn-sphere radius in TD world units around the body anchor. Suggested 0.03-0.4. Default 0.2.',
      },
      blendMode: {
        type: Type.STRING,
        description: '"additive" for emissive spells (fire, light, plasma) — sums brightness; "alpha" for physical spells (crystal, earth, shadow) — particles occlude each other.',
      },
    },
  },
};

/**
 * All tools (for initial chat setup)
 */
export const MERLIN_TOOLS: FunctionDeclaration[] = [
  GET_POSTURE_TOOL,
  GET_EXPRESSION_TOOL,
  GET_FACE_EVENTS_TOOL,
  SET_SPELL_PROFILE_TOOL,
  PREPARE_CASTING_TOOL,
  SET_ZONE_SHADER_TOOL,
  REGISTER_EFFECT_TRIGGERS_TOOL,
  REQUEST_VISUAL_FEEDBACK_TOOL,
  GENERATE_SPRITE_TOOL,
  SET_CAST_PARAMS_TOOL,
  SET_PARTICLE_PARAMS_TOOL,
];

/**
 * Visual-author tool subset for the Live Spell test (and future
 * automated visual authoring contexts).
 *
 * Drops: get_posture, get_expression (no body data in test mode),
 * set_spell_profile (metadata-only, no visual effect),
 * prepare_casting (live-experience cast trigger).
 *
 * Keeps: the three tools that actually shape what's on screen.
 */
export const MERLIN_VISUAL_AUTHOR_TOOLS: FunctionDeclaration[] = [
  SET_ZONE_SHADER_TOOL,
  REQUEST_VISUAL_FEEDBACK_TOOL,
  GENERATE_SPRITE_TOOL,
  SET_CAST_PARAMS_TOOL,
  SET_PARTICLE_PARAMS_TOOL,
];
