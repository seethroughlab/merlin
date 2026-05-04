**Merlin Mirror**

Implementation Plan

*Aligned with Merlin_Mirror_PRD.docx  ·  Fivestone Studios  ·  May 2026*

# **Purpose**

This document defines the practical migration path from the existing Parlor / Mentalist prototype into the Merlin Mirror experience.

The goal is not to rebuild from scratch. The existing prototype already contains a strong foundation:

* Electron application shell

* MediaPipe body / face tracking

* Whisper speech recognition

* Gemini analysis and conversation integration

* TTS playback

* TouchDesigner WebSocket bridge

* Mentalist session state machine

* Tool-calling patterns

* Existing TouchDesigner shader zone concepts

The implementation plan focuses on transforming that foundation into a coherent Merlin experience where conversation, perception, spell state, and TouchDesigner POP particle behavior are tightly connected.

# **1. Current System Audit**

## **1.1 Existing Strengths**

### **Conversation / Session Layer**

The current system already has a MentalistSession class that manages:

* session lifecycle

* conversation history

* phase progression

* Gemini chat calls

* tool call handling

* insight accumulation

* session completion

This should be reused as the basis for a new MerlinSession class.

### **Gemini Tool Calling**

The current system already supports Gemini tool calls such as:

* trigger_reveal

* set_mood

* request_body_analysis

* request_face_analysis

* set_visual_scene

* trigger_visual_reveal

* set_skeleton_overlay

* update_particle_zone

This is a strong foundation. The Merlin system should replace the mentalist tools with spell-specific tools, but preserve the overall mechanism.

### **Perception Pipeline**

The current system already captures and analyzes:

* body language

* posture

* movement

* openness

* tension

* engagement

* facial valence

* arousal

* primary emotion

These values are extremely useful for Merlin, but they should be reframed away from “reading” the user and toward “shaping the spell.”

### **TouchDesigner Bridge**

The current WebSocket bridge already supports outbound messages such as:

* mood_update

* scene_params

* reveal_effect

* skeleton_augment

* zone_update

* analysis_update

* tracking_frame

The Merlin build should extend this protocol rather than replace it.

### **POP Shader Zones**

The TouchDesigner shader templates now define five useful particle behavior zones:

* spawn

* force

* velmod

* size

* color

This maps cleanly to the Merlin spell system.

## **1.2 Current Weaknesses / Gaps**

### **Mentalist Framing Is No Longer Appropriate**

The existing experience frames body and face analysis as a cold reading. Merlin should instead treat perception as magical environmental context.

Mentalist pattern:

*“Your posture tells me something about you.”*

Merlin pattern:

*“Your spell is gathering at your hands.”*

### **Visuals Are Not Yet Meaning-Driven Enough**

The current bridge can push visual changes, but the visuals are still driven mostly by mood, phase, or raw analysis values.

Merlin needs a stronger chain:

User input → Interpretation → SpellState → ParticleSpellProgram → POP behavior

### **No Explicit Spell State**

The current system accumulates MentalistInsight objects. Merlin needs a structured SpellState that captures:

* spell intent

* element

* tone

* energy

* casting origin

* magic word

* visual archetype

* particle behavior

### **No Buildup / Release Visual Distinction**

The current bridge can push visual changes, but it does not distinguish between two visually different modes that the experience needs:

* Buildup: continuous gathering particles during conversation that hold attention and foreshadow the spell.

* Release: the casting effect itself, projected from the casting origin at peak intensity.

These are designed and tuned independently in the PRD (§8). The implementation must treat them as separate code paths with separate parameter envelopes — see Phase 5.

### **No Casting Gate**

The current system has reveal effects, but Merlin needs a physical climax:

magic word spoken + origin-specific gesture detected → cast spell

### **GLSL Validation Is Too Loose**

The current system wraps GLSL snippets for broad zones. Merlin needs stricter validation because Gemini will generate code fragments for specific POP shader insertion zones.

# **2. Migration Strategy**

### **Core Strategy**

Build Merlin as a sibling feature to Mentalist first, not as an immediate destructive replacement.

Recommended structure:

src/main/mentalist/  
src/main/merlin/

This allows the existing prototype to remain available while Merlin becomes stable.

Once Merlin is proven, the UI can hide or remove Mentalist mode.

# **3. Implementation Phases**

## **Phase 1 — Create Merlin Session Skeleton**

### **Goal**

Create a working Merlin mode that reuses the existing backend mechanics but changes the experience framing — and, importantly, changes the order of operations during Discovery so the system reads the user before asking them to declare an intent.

**Design principle (PRD §15, §6.1):** Discovery is observe → hypothesize → confirm, not ask → declare → form. Merlin uses posture and expression to form a hypothesis about the user, names that hypothesis aloud (“there’s a stillness in you”), and lets the user accept or correct it before the spell archetype is committed. Voice intent is one signal among several, not the entry point.

### **Tasks**

#### ***1. Create Merlin module***

Add:

src/main/merlin/index.ts  
src/main/merlin/session.ts  
src/main/merlin/types.ts  
src/main/merlin/prompts.ts  
src/main/merlin/gemini-chat.ts  
src/main/merlin/spell-state.ts

Start by copying the structure from src/main/mentalist/, then modify.

#### ***2. Define Merlin phases***

Replace:

export type MentalistPhase = 'idle' | 'intro' | 'reading' | 'reveal' | 'finale';

with:

export type MerlinPhase =  
  | 'idle'  
  | 'wake'  
  | 'intro'  
  | 'discovery'  
  | 'formation'  
  | 'ready_to_cast'  
  | 'casting'  
  | 'outro';

#### ***3. Define phase turn targets***

Suggested MVP timing:

const DEFAULT_MERLIN_PHASE_CONFIG = {  
  introTurns: 1,  
  discoveryTurns: 3,  
  formationTurns: 1,  
  castingTurns: 1,  
  outroTurns: 1,  
};

The experience should feel shorter and more directed than the mentalist version. Discovery turns should typically follow this rhythm:

1. Turn 1 — Merlin observes and offers a hypothesis (e.g. “there’s a stillness in you — like someone who only just set something down. Does that sound right?”). Drives a get_posture / get_expression tool call before the spoken response.

2. Turn 2 — Merlin refines based on the user’s confirmation or correction (warmth, energy, color).

3. Turn 3 — Optional sharpening turn used only if confidence in the spell archetype is still low.

If the user clearly states an intent up front (“I want confidence”), Merlin still observes and reflects before committing — it is the named-back observation that makes the user feel seen.

#### ***4. Implement the discovery loop***

Each discovery turn runs an observe → hypothesize → confirm cycle:

async function runDiscoveryTurn(session: MerlinSession): Promise<void> {  
  const posture    = await tools.get_posture();  
  const expression = await tools.get_expression();  
  const hypothesis = await gemini.formHypothesis({  
    posture, expression,  
    transcript: session.lastUserInput,  
    spell: session.spell,  
  });  
  // Spoken response should NAME the hypothesis back to the user  
  // and invite confirmation, not list observations.  
  await session.speak(hypothesis.spokenText);  
  session.spell = mergeSpellUpdate(session.spell, hypothesis.spellUpdate);  
  session.spell.confidence = hypothesis.confidenceScore;  
}

Perception is sparing, not surveillant: posture and expression are queried at decision points (wake, hypothesis, casting), not continuously, and Merlin never narrates raw observations back to the user.

#### ***5. Add wake phrase handling***

The renderer or main process should listen for:

Hello Merlin

Wake phrase should trigger:

merlin-start

This can initially be implemented with fuzzy transcript matching.

### **Acceptance Criteria**

* User can start Merlin mode.

* Merlin greets the user in character.

* Merlin opens Discovery with an observation, not a menu — the first substantive turn names a hypothesis the user can confirm or correct.

* User can speak back and receive Merlin responses.

* Session progresses through phases.

* Existing Mentalist mode remains intact.

## **Phase 2 — Replace Mentalist Insight with SpellState**

### **Goal**

Create an explicit spell representation that can drive visuals.

### **Tasks**

#### ***1. Add SpellState***

In src/main/merlin/types.ts:

export type SpellIntent =  
  | 'confidence'  
  | 'calm'  
  | 'protection'  
  | 'clarity'  
  | 'creativity'  
  | 'transformation'  
  | 'release'  
  | 'focus'  
  | 'joy'  
  | 'wonder';

export type SpellElement =  
  | 'fire'  
  | 'water'  
  | 'air'  
  | 'earth'  
  | 'light'  
  | 'shadow'  
  | 'crystal'  
  | 'storm'  
  | 'flora'  
  | 'cosmic';

export type CastingOrigin =  
  | 'hands'  
  | 'heart'  
  | 'eyes'  
  | 'whole_body'  
  | 'wand';

export interface SpellState {  
  intent: SpellIntent | null;  
  element: SpellElement | null;  
  tone: 'gentle' | 'playful' | 'mysterious' | 'heroic' | 'calm' | 'wild' | null;  
  energy: number;  
  complexity: number;  
  castingOrigin: CastingOrigin | null;  
  visualArchetype: ParticleSpellArchetype | null;  
  palette: string | null;  
  magicWord: string | null;  
  confidence: number;  
}

#### ***2. Add MerlinSessionState***

export interface MerlinSessionState {  
  phase: MerlinPhase;  
  turnCount: number;  
  spell: SpellState;  
  conversationSummary: string;  
  bodyHistory: BodySnapshot[];  
  faceHistory: FaceSnapshot[];  
  lastVisualProgram?: ParticleSpellProgram;  
  castReady: boolean;  
  castCompleted: boolean;  
}

#### ***3. Replace MentalistInsight[] with SpellState***

Mentalist accumulates many insights. Merlin should converge toward one coherent spell.

Instead of:

insights: MentalistInsight[];

use:

spell: SpellState;

#### ***4. Add spell reducer***

Create:

src/main/merlin/spell-state.ts

Core function:

export function mergeSpellUpdate(  
  current: SpellState,  
  update: Partial<SpellState>  
): SpellState

This should:

* clamp numeric values

* reject unknown enum values

* preserve previous values when Gemini gives null accidentally

* gradually increase confidence when repeated signals agree

### **Acceptance Criteria**

* Each user turn updates SpellState.

* Merlin can reference the spell state in speech.

* The state can be logged and inspected.

* The system avoids contradictory spell shifts unless the user clearly changes direction.

## **Phase 3 — Rewrite Gemini Prompting for Merlin**

### **Goal**

Replace cold-reading prompt logic with spell-guiding prompt logic, structured as a layered prompt that is composed each turn (PRD §6.2).

### **Tasks**

#### ***1. Build the prompt as four explicit layers***

Each Gemini call composes the prompt from four layers rather than a single monolithic string. This keeps the static identity stable, isolates per-turn context, and lets the output contract evolve without rewriting the persona.

File:

src/main/merlin/prompts.ts

#### ***Layer 1 — System Identity Prompt***

Stable across the session. Defines Merlin: tone, constraints, ritual structure, safety rules. Includes the prohibition on harmful, coercive, or dark spell framing, and the perception ethic (sparing, never narrate raw observations back to the user).

export function buildSystemPrompt(): string {  
  return [  
    MERLIN_PERSONA,  
    MERLIN_RITUAL_STRUCTURE,  
    MERLIN_TONE_AND_CONSTRAINTS,  
    MERLIN_SAFETY_RULES,  
    PERCEPTION_ETHIC,  
  ].join('\n\n');  
}

#### ***Layer 2 — Session Context***

Injected each turn. Carries the moving parts of the session into the model:

{  
  "stage": "discovery | formation | casting",  
  "spell_state": { ... },          // current SpellState  
  "recent_user_input": "...",       // last transcript  
  "perception_summary": {           // most recent posture / expression  
    "posture": "...",  
    "expression": "...",  
    "freshness_ms": 1200  
  }  
}

#### ***Layer 3 — Tool Schema***

Declares the actions Gemini is allowed to take this turn. Tool declarations are derived from the active phase — for example, cast_spell is only declared during ready_to_cast and casting.

{  
  "tools": [  
    "get_posture",  
    "get_expression",  
    "set_spell_profile",  
    "update_particle_spell_program",  
    "prepare_casting",  
    "cast_spell"  
  ]  
}

#### ***Layer 4 — Output Contract (strict)***

Gemini must return structured JSON conforming to MerlinTurnOutput. The schema is sent every turn so the model cannot drift to free-form prose.

export interface MerlinTurnOutput {  
  spokenText: string;  
  phase: MerlinPhase;  
  spellUpdate: Partial<SpellState>;  
  toolCalls: MerlinToolCall[];  
  visualDirectives: MerlinVisualDirective[];  
  control: {  
    expectUserReply: boolean;  
    advancePhase: boolean;  
    endSession: boolean;  
  };  
}

#### ***2. Keep the best mentalist mechanics***

Preserve these mentalist patterns inside Layer 1:

* specific observations

* hedged interpretations

* real-time callouts

* “always keep the interaction moving”

* use tool calls sparingly

Transform them:

*Mentalist: “Your posture tells me you are guarded.”*

*Merlin: “Your spell is holding itself close — protective, but not afraid.”*

#### ***3. Add response repair path***

If Gemini returns invalid JSON:

1. attempt JSON extraction

2. attempt schema repair with a small corrective prompt

3. if still invalid, use fallback response

Fallback example:

*The mirror flickers — but the magic remains. Tell me one thing this spell should help you find.*

### **Acceptance Criteria**

* Each turn composes the prompt from the four layers; identity does not vary turn-to-turn.

* Gemini responses are parseable against MerlinTurnOutput.

* Spoken text stays short.

* Spell updates are structured.

* Gemini does not drift into mentalist language.

* Tool declarations are gated by phase.

* Invalid output does not break the session.

## **Phase 4 — Update Tool Schema for Merlin**

### **Goal**

Replace mentalist-oriented tools with Merlin-specific tools.

### **Current Tool Concepts to Keep**

* request fresh body analysis

* request fresh face analysis

* update visual scene

* trigger reveal / climax

* update particle zones

### **New Merlin Tools**

#### ***get_posture***

Returns semantic posture and gesture state.

interface GetPostureResult {  
  trackingConfidence: number;  
  bodyVisible: boolean;  
  handsVisible: boolean;  
  gestureFlags: {  
    handsRaised: boolean;  
    oneHandForward: boolean;  
    bothHandsForward: boolean;  
    handsNearHeart: boolean;  
    armsSpread: boolean;  
    castingReady: boolean;  
  };  
  posture: {  
    stance: string;  
    arms: string;  
    hands: string;  
    torso: string;  
    head: string;  
    movementEnergy: number;  
  };  
}

#### ***get_expression***

Returns expression summary.

interface GetExpressionResult {  
  faceVisible: boolean;  
  expressionConfidence: number;  
  expression: {  
    primary: string;  
    valence: number;  
    arousal: number;  
    engagement: number;  
  };  
}

#### ***set_spell_profile***

Updates global visual spell profile.

#### ***update_particle_spell_program***

Sends a validated POP shader-zone program to TouchDesigner.

#### ***prepare_casting***

Charges visuals and prompts gesture readiness.

#### ***cast_spell***

Triggers the final casting visual.

### **Acceptance Criteria**

* Tool names and semantics match Merlin experience.

* Gemini can request perception data.

* Gemini can trigger visual updates without touching raw TD details directly.

* Tool outputs are logged for debugging.

## **Phase 5 — Map SpellState to ParticleSpellProgram**

### **Goal**

Translate the abstract spell state into concrete POP particle behavior, with separate code paths for the two visual modes the experience requires (PRD §8).

**Design principle (PRD §8.1):** The mirror has two visual modes — Buildup (continuous gathering during conversation) and Release (the casting effect). They are designed and tuned independently. Conflating them is a primary failure mode: buildup that is too intense steals the climax; release that resembles buildup feels like a non-event.

### **Tasks**

#### ***1. Define particle spell types***

Create:

src/main/merlin/particle-program.ts

export type ShaderZoneName = 'spawn' | 'force' | 'velmod' | 'size' | 'color';

export type ParticleSpellArchetype =  
  | 'rising_embers'  
  | 'orbiting_stardust'  
  | 'breathing_aura_mist'  
  | 'protective_ring'  
  | 'hand_trail_ribbons'  
  | 'heart_pulse'  
  | 'eye_beam_sparks'  
  | 'crystal_growth_burst'  
  | 'storm_static_field';

export interface ShaderZonePatch {  
  enabled: boolean;  
  name: string;  
  description: string;  
  code: string;  
}

export type SpellVisualMode = 'buildup' | 'release';

export interface ParticleSpellProgram {  
  version: '1.0';  
  spellId: string;  
  intent: SpellIntent;  
  element: SpellElement;  
  archetype: ParticleSpellArchetype;  
  energy: number;            // 0..1, ALWAYS clamped below castingThreshold in buildup  
  complexity: number;  
  castingOrigin: CastingOrigin;  
  mode: SpellVisualMode;     // determines parameter envelope below  
  zones: Partial<Record<ShaderZoneName, ShaderZonePatch>>;  
}

#### ***2. Define mode envelopes***

Each archetype must produce two distinct programs from the same SpellState — one for buildup, one for release. The envelopes differ along these axes:

| Axis | Buildup envelope | Release envelope |
| :---- | :---- | :---- |
| **Energy** | 0.10 – 0.55, slowly rising as confidence increases. | 0.85 – 1.00 at ignition, decaying to 0.20 in afterglow. |
| **Direction** | Inward / gathering toward the casting origin. | Outward / projected from the casting origin. |
| **Particle density** | Low to moderate; visible but not saturated. | Peak burst, then decay. |
| **Motion** | Drift, breathing rhythm, slow modulation. | Directional spike along origin vector, then settle. |
| **Color saturation** | 60–80% of release saturation; identity-tinted but soft. | Full archetype saturation. |
| **Reactivity to perception** | Subtle modulation by posture / gaze. | Locked once cast trigger fires. |

#### ***3. Implement deterministic archetype presets first***

Before allowing Gemini to generate shader code, implement deterministic presets for both modes:

export function createBuildupProgram(spell: SpellState): ParticleSpellProgram  
export function createReleaseProgram(spell: SpellState): ParticleSpellProgram

Start with three archetypes, each with both mode programs:

1. rising_embers — confidence / fire / hands

2. breathing_aura_mist — calm / water / heart or whole_body

3. orbiting_stardust — creativity / cosmic / hands or silhouette

#### ***4. Drive buildup continuously during Discovery and Formation***

Buildup is not a single message — it is the visual mode that is active throughout conversation. The orchestrator should:

* Push an initial buildup program at the start of Discovery (generic, low-energy, identity not yet committed).

* Re-push an updated buildup program whenever SpellState changes meaningfully (intent, element, or origin firms up).

* Continue self-modulating on the TD side between updates so the mirror is never visually dead during pauses.

* Modulate buildup density and motion subtly from the latest perception summary (posture energy, gaze).

#### ***5. Add parameterization***

Use spell values to adjust:

* particle density

* velocity

* force magnitude

* color palette

* alpha fade

* burst intensity (release only)

* motion speed

#### ***6. Add Gemini customization later***

Only after deterministic presets work should Gemini provide zone patches.

Recommended progression:

Preset only → preset + parameters → preset + Gemini color/size snippets → Gemini force/spawn snippets

### **Acceptance Criteria**

* Each spell state produces two valid particle programs (buildup + release) for any supported archetype.

* Buildup energy never exceeds the casting threshold.

* Release programs are visibly distinct from buildup programs of the same archetype.

* TD can receive and apply both programs.

* Visuals clearly differ across archetypes.

* No Gemini GLSL is required for MVP success.

## **Phase 6 — Update TouchDesigner Bridge Protocol**

### **Goal**

Extend the existing WebSocket protocol to support Merlin and POP particle programs, including the buildup vs release distinction.

### **Current Relevant Message Types**

The existing bridge already supports:

{ type: 'zone_update'; zone: ZoneName; glsl_code: string }  
{ type: 'analysis_update'; ... }  
{ type: 'reveal_effect'; ... }  
{ type: 'tracking_frame'; ... }

### **Recommended New Message Types**

Add:

export type TDOutboundMessage =  
  | ExistingMessages  
  | { type: 'merlin_state'; active: boolean; phase?: MerlinPhase; spell?: SpellState }  
  | { type: 'spell_profile'; spell: SpellState }  
  | { type: 'particle_spell_program'; mode: 'buildup' | 'release'; program: ParticleSpellProgram }  
  | { type: 'spell_charge'; origin: CastingOrigin; intensity: number; durationMs: number }  
  | { type: 'spell_cast'; origin: CastingOrigin; intensity: number; durationMs: number; envelope: CastEnvelope };

CastEnvelope is the three-beat shape defined in Phase 8. The mode field on particle_spell_program tells TD whether to apply the message as the active buildup mode or as the release effect.

### **Zone Name Migration**

The current bridge has older zone names:

'force_field'  
'spawn_behavior'  
'color_over_life'  
'size_over_life'  
'velocity_modifier'

The POP templates use cleaner names:

'spawn'  
'force'  
'velmod'  
'size'  
'color'

Recommended mapping:

const ZONE_NAME_TO_TD = {  
  spawn: 'spawn_behavior',  
  force: 'force_field',  
  velmod: 'velocity_modifier',  
  size: 'size_over_life',  
  color: 'color_over_life',  
};

Long-term, update both sides to the simpler names.

### **Acceptance Criteria**

* TD receives Merlin state updates.

* TD receives full particle programs tagged by mode.

* TD can compile and acknowledge zone updates.

* Electron can detect compile failures.

## **Phase 7 — Implement GLSL Zone Validation**

### **Goal**

Prevent Gemini-generated zone snippets from breaking the experience.

### **Tasks**

#### ***1. Create validator***

File:

src/main/merlin/glsl-validator.ts

Core function:

export function validateZonePatch(  
  zone: ShaderZoneName,  
  code: string  
): { valid: boolean; errors: string[]; sanitizedCode?: string }

#### ***2. Add mutation allowlist***

const ZONE_MUTATION_ALLOWLIST = {  
  spawn: ['pos', 'vel', 'seed'],  
  force: ['force'],  
  velmod: ['vel'],  
  size: ['size'],  
  color: ['color'],  
};

#### ***3. Reject dangerous tokens***

Reject snippets containing:

for  
while  
do  
switch  
case  
break  
continue  
discard  
return  
#define  
#include  
uniform  
layout  
buffer  
sampler  
texture  
image  
atomic  
shared  
barrier  
memoryBarrier

#### ***4. Enforce limits***

* max 8–12 lines per zone

* max character count

* no function definitions

* no new uniforms

* no output writes

* no extremely high numeric literals

#### ***5. Add fallback patches***

Fallbacks:

const FALLBACK_ZONE_PATCHES = {  
  spawn: '',  
  force: 'force += vec3(0.0, 0.02 * life, 0.0);',  
  velmod: 'vel *= 0.95;',  
  size: 'size = clamp(size, 0.002, 0.08);',  
  color: 'color.a = clamp(color.a, 0.0, 1.0);',  
};

### **Acceptance Criteria**

* Bad snippets are rejected before TD sees them.

* Compile failures fallback gracefully.

* Logs explain why code was rejected.

* Gemini cannot mutate variables outside the zone contract.

## **Phase 8 — TouchDesigner POP Integration**

### **Goal**

Make the TouchDesigner system respond to Merlin particle programs and render the casting visual with a defined three-beat envelope.

### **Tasks**

#### ***1. Confirm shader template wiring***

Each shader file should expose a clearly marked insertion area:

// === custom behavior ===  
// Gemini / Electron validated patch goes here  
// === end custom behavior ===

#### ***2. Add TD-side zone update handler***

In the TD WebSocket callback script, map incoming zone_update or particle_spell_program messages to the correct shader DATs. The handler must respect the message's mode field — buildup messages update the active continuous program, while release messages arm the cast envelope without disturbing the buildup state.

#### ***3. Implement the three-beat cast envelope***

PRD §8.3 specifies that the casting visual is not a single burst but a three-beat shape: ignition → projection → afterglow. TD must implement this as a controlled envelope rather than a free-running effect.

interface CastEnvelope {  
  ignitionMs:   number;  // sharp rise at the casting origin  
  projectionMs: number;  // peak burst projected along the origin vector  
  afterglowMs:  number;  // decay back to a calmer buildup state  
  peakIntensity: number; // 0..1  
}

// Example default envelope for a 4500ms cast  
const DEFAULT_CAST_ENVELOPE: CastEnvelope = {  
  ignitionMs:   400,  
  projectionMs: 1200,  
  afterglowMs:  2900,  
  peakIntensity: 1.0,  
};

On the TD side, drive the envelope with a sequenced parameter ramp:

* Beat 1 — Ignition: cast intensity ramps from 0 to peak over ignitionMs. Optional brief temporal slowdown. Buildup is suppressed.

* Beat 2 — Projection: particles emit from the casting origin along the spell's vector at peak intensity for projectionMs. Force fields amplified.

* Beat 3 — Afterglow: intensity decays smoothly across afterglowMs. The buildup program re-establishes itself at reduced energy as the afterglow fades.

Electron sends the envelope alongside the spell_cast message; TD does not invent its own timing.

#### ***4. Add compile result messages***

TD should send back:

{  
  "type": "compile_result",  
  "zone": "force",  
  "success": true  
}

or:

{  
  "type": "compile_result",  
  "zone": "force",  
  "success": false,  
  "error": "..."  
}

#### ***5. Add uniform inputs***

Minimum uniforms:

uniform float uTime;  
uniform float uDeltaTime;  
uniform float uValence;  
uniform float uArousal;  
uniform float uTension;  
uniform float uOpenness;  
uniform float uEngagement;  
uniform vec3 uBodyCenter;

Recommended Merlin uniforms:

uniform vec3 uHead;  
uniform vec3 uHeart;  
uniform vec3 uLeftHand;  
uniform vec3 uRightHand;  
uniform vec3 uLeftEye;  
uniform vec3 uRightEye;  
uniform vec3 uWandTip;  
uniform float uHandDistance;  
uniform float uHandHeight;  
uniform float uHandVelocity;  
uniform float uVoiceAmp;  
uniform float uSpellCharge;  
uniform float uCastTrigger;     // 0 in buildup, 1 during cast envelope  
uniform float uCastBeat;        // 0..1 phase within ignition→projection→afterglow  
uniform float uTrackingConfidence;

#### ***6. Add visual debug mode***

Debug overlay should show:

* current phase

* active visual mode (buildup / release)

* spell intent

* element

* archetype

* casting origin

* magic word

* active shader zones

* cast envelope progress

* TD FPS

* particle count

### **Acceptance Criteria**

* TD can apply at least three deterministic particle programs in both buildup and release modes.

* The cast envelope is observably three-beat — ignition reads as distinct from projection, afterglow reads as a return to calmer buildup.

* TD can receive uniform updates from tracking data.

* Compile failures do not crash the visual system.

* Debug mode makes it clear what is happening.

## **Phase 9 — Casting Mechanic**

### **Goal**

Create the physical climax of the experience. The casting gesture is determined by the spell's casting origin (PRD §10) so the act of casting itself reflects the spell's character.

**Design principle (PRD §7.1):** The emanation point is not a configuration knob — it is part of the spell's meaning. A spell of release lives at the chest. A spell of clarity lives at the eyes. A spell of creativity lives at the hands. A spell of protection wraps the whole body. Merlin selects the origin during Discovery, names it back to the user (“your magic gathers at your hands”), and the visual system anchors particles, force fields, and casting motion to that point on the body.

### **Requirements**

Casting requires both an origin-specific gesture and the spoken magic word:

gestureReadyFor(spell.castingOrigin) === true && magicWordDetected === true

### **Tasks**

#### ***1. Encode intent → origin defaults***

Gemini selects the casting origin during Discovery, but it should default along these mappings (PRD §7.1) and only override with a clear reason from posture or user statement:

| Origin | Spell character it tends to carry |
| :---- | :---- |
| **hands** | Creativity, transformation, focus, bold confidence — outward-projecting, tool-like, expressive. |
| **heart** | Calm, release, joy, quiet confidence — inward, settling, breath-anchored. |
| **eyes** | Clarity, perception, wonder — directional, attention-shaping, reaches outward into the world. |
| **whole_body** | Protection, grounding, ritual presence — enveloping rather than emitting. |
| **wand** | Theatrical or directed casting when a physical prop is present. (Future.) |

Provide a deterministic default function so Merlin always has a sensible origin even before Gemini commits one:

export function defaultOriginForIntent(intent: SpellIntent): CastingOrigin {  
  switch (intent) {  
    case 'creativity': case 'transformation': case 'focus':  
      return 'hands';  
    case 'calm': case 'release': case 'joy':  
      return 'heart';  
    case 'clarity': case 'wonder':  
      return 'eyes';  
    case 'protection':  
      return 'whole_body';  
    case 'confidence':  
      // bold confidence → hands; quiet confidence → heart.  
      // Discovery refines based on tone before commit.  
      return 'hands';  
  }  
}

#### ***2. Have Merlin name the origin in language***

During Formation, Merlin should speak the casting origin into the ritual so the user feels it before they cast. Examples:

*“Your magic gathers at your hands.”*

*“Place a hand where you feel the weight — the chest, often.”*

*“This one lives behind the eyes. Keep them on the mirror.”*

This is a prompt-shaping concern, not a code concern, but it should be enforced via a Layer-1 instruction in the system prompt: when castingOrigin is set, Merlin must name it before requesting the casting gesture.

#### ***3. Magic word detection***

Use fuzzy matching against the transcript.

Example:

function transcriptContainsMagicWord(transcript: string, magicWord: string): boolean

Implementation should allow:

* minor transcription errors

* phonetic approximations

* case-insensitivity

* extra words before or after

#### ***4. Origin-specific gesture detection***

Each origin defines its own gesture-ready predicate, so the body movement that releases the spell matches where the spell lives:

| Casting origin | Gesture-ready condition |
| :---- | :---- |
| **hands** | Hands raised above shoulder height with palms forward; brief stillness. |
| **heart** | Open palm placed at the sternum; held for a short beat on the exhale. |
| **eyes** | Sustained gaze toward the mirror with head lifted; chin level. |
| **whole_body** | Arms opened wide or stance grounded with weight centered; brief stillness. |
| **wand** | Wand tip raised and stable, tracked above shoulder height. |

Implementation:

export function gestureReadyFor(origin: CastingOrigin, posture: GetPostureResult): boolean {  
  switch (origin) {  
    case 'hands':      return posture.gestureFlags.handsRaised || posture.gestureFlags.bothHandsForward;  
    case 'heart':      return posture.gestureFlags.handsNearHeart && posture.posture.movementEnergy < 0.2;  
    case 'eyes':       return posture.bodyVisible && posture.posture.head === 'lifted';  
    case 'whole_body': return posture.gestureFlags.armsSpread || posture.posture.stance === 'grounded';  
    case 'wand':       return posture.gestureFlags.castingReady; // wand tip tracking flag  
  }  
}

#### ***5. Charge state***

Before casting, enter a charged state:

spellCharge: 0 → 1

TD should show particles tightening around the casting origin during charge. This is still buildup mode — energy stays below the casting threshold until the cast trigger fires.

#### ***6. Cast trigger***

When both conditions are met:

triggerSpellCast()

This sends:

{ type: 'spell_cast', origin, intensity: 1.0, durationMs: 4500, envelope: DEFAULT_CAST_ENVELOPE }

TD applies the three-beat envelope (Phase 8\) anchored at the casting origin.

### **Acceptance Criteria**

* Each spell has a defined casting origin by Formation; defaults are applied early so origin is never null at gesture time.

* Merlin names the casting origin in dialogue before requesting the gesture.

* User understands what to do.

* The right gesture for the wrong origin does not cast (e.g. hands raised for a heart spell does not fire).

* Magic word alone does not cast unless the origin's gesture condition is also satisfied.

* Final cast feels visually distinct from prior buildup.

## **Phase 10 — Visual Evaluation Loop**

### **Goal**

Allow Gemini to evaluate snapshots of TouchDesigner output and adjust the spell.

This is not required for the first MVP, but it is a strong differentiator.

### **Tasks**

#### ***1. Add TD snapshot capture***

TouchDesigner should periodically or on request provide a snapshot image.

Options:

* TD sends base64 image over WebSocket.

* Electron captures from Spout / preview feed.

* TD writes latest frame to a known file path and Electron reads it.

#### ***2. Add evaluate_visual_output***

Gemini receives:

* current SpellState

* current ParticleSpellProgram

* rendered snapshot

* phase

It returns:

interface VisualEvaluationResult {  
  coherence: number;  
  matchesIntent: boolean;  
  readableSilhouette: boolean;  
  tooChaotic: boolean;  
  tooDim: boolean;  
  tooBright: boolean;  
  suggestedAdjustments: Partial<SpellState>;  
  suggestedProgramAdjustments: Partial<ParticleSpellProgram>;  
}

#### ***3. Use only at key moments***

Do not evaluate every frame.

Recommended triggers:

* after first formation visual

* before ready-to-cast

* after cast effect during tuning/debug mode

#### ***4. Safety check***

Gemini should not be the only visual safety validator. Electron / TD should still clamp brightness, flicker, and particle intensity.

### **Acceptance Criteria**

* Snapshot evaluation can identify obvious mismatches.

* Adjustments are bounded.

* The loop improves coherence without creating instability.

## **Phase 11 — Gemini API Usage Plan**

### **Goal**

Use Gemini capabilities deliberately rather than as one monolithic model call.

### **Recommended API Uses**

#### ***1. Gemini text / reasoning model***

Use for:

* Merlin conversation

* spell state updates

* tool-call decisions

* structured JSON output

Recommended usage:

* low-to-medium temperature

* strict output schema

* tool declarations enabled

#### ***2. Gemini multimodal analysis***

Use for:

* face strip analysis

* body / skeleton strip analysis

* TouchDesigner snapshot evaluation

The existing code already uses Gemini image input for body and face analysis. Extend the same pattern for rendered output snapshots.

#### ***3. Gemini Live / streaming output***

Use for:

* lower perceived latency

* voice output streaming

* more natural back-and-forth timing

The current code already includes live TTS infrastructure. Merlin should preserve this.

#### ***4. Function calling***

Use for:

* get_posture

* get_expression

* update_particle_spell_program

* prepare_casting

* cast_spell

* evaluate_visual_output

### **Model Separation Strategy**

Do not require the same model path for every task.

Recommended separation:

| Task | Model / Capability |
| :---- | :---- |
| **Conversation + spell state** | fast text/reasoning Gemini model |
| **Body / face analysis** | multimodal Gemini model |
| **Visual snapshot evaluation** | multimodal Gemini model |
| **TTS** | Gemini Live / TTS path already in app |
| **GLSL snippet generation** | text/reasoning model with strict schema |

### **Acceptance Criteria**

* Calls are separated by purpose.

* Expensive image evaluation is not called unnecessarily.

* Conversation latency remains acceptable.

* All Gemini outputs pass validation before affecting TD.

## **Phase 12 — Renderer / UI Updates**

### **Goal**

Update the Electron renderer interface for Merlin development and debugging.

### **Tasks**

#### ***1. Add Merlin panel***

Show:

* active / inactive

* phase

* current transcript

* Merlin response

* spell state (incl. casting origin)

* active visual mode (buildup / release)

* magic word

* cast readiness per origin

* TD connection status

#### ***2. Add manual controls***

For debugging:

* Start Merlin

* End Merlin

* Force phase

* Generate random spell

* Trigger charge

* Trigger cast (per origin)

* Apply archetype preset (buildup / release)

* Send test zone patch

#### ***3. Rename mode labels***

Avoid mentalist language in user-facing controls.

Replace:

Mentalist Mode

with:

Merlin Mode

or:

Mirror Experience

### **Acceptance Criteria**

* Developer can test without voice input.

* Developer can test without TD connected.

* Developer can test without Gemini connected using fallback presets.

# **4. MVP Definition**

### **MVP Experience**

The MVP is successful if:

1. User says “Hello Merlin.”

2. Merlin begins a short guided conversation that opens with observation, not a menu — using posture and expression to form a hypothesis about the user before asking what spell they want.

3. Merlin names the hypothesis aloud and the user confirms or corrects it; spell intent emerges from that exchange (and may also be stated outright by the user).

4. System derives a structured SpellState, including a casting origin chosen to match the spell's character.

5. TouchDesigner runs buildup mode throughout — particles continuously gather toward the casting origin and ease toward the spell's identity.

6. Merlin gives a magic word and names the casting origin in language.

7. User performs the origin-specific gesture and says the magic word.

8. Final spell cast visual triggers in release mode with the three-beat envelope (ignition → projection → afterglow) anchored at the casting origin.

9. Merlin ends the session and visuals return to idle.

### **MVP Technical Scope**

Must include:

* Merlin layered prompt (system identity / session context / tool schema / output contract)

* Merlin session state with phase and SpellState

* Perception-led discovery loop (observe → hypothesize → confirm) using get_posture and get_expression

* Intent → casting origin defaults; origin must be set before Formation completes

* Deterministic ParticleSpellProgram presets for both buildup and release modes

* TD protocol updates including mode tag and cast envelope

* At least three visual archetypes, each with buildup + release programs

* Origin-specific casting gesture detection

* Magic word detection

* Three-beat cast envelope on the TD side

* Safe fallbacks for tracking loss, silence, inappropriate requests

Does not need yet:

* fully Gemini-generated GLSL

* wand tracking

* cauldron

* visual snapshot evaluation loop

* multi-user spells

* persistent memory

# **5. Recommended Build Order**

### **Week / Sprint 1 — Merlin Conversation + State**

1. Create src/main/merlin module.

2. Copy and adapt session structure from Mentalist.

3. Add SpellState.

4. Build the four-layer Merlin prompt (system / session / tools / output).

5. Implement the perception-led discovery loop.

6. Add Merlin IPC handlers.

7. Add wake phrase detection.

8. Confirm voice conversation works.

Deliverable:

*Merlin can talk to the user, observe posture/expression, form a hypothesis, and maintain structured spell state including casting origin.*

### **Week / Sprint 2 — Deterministic Visual Mapping**

1. Implement ParticleSpellProgram with mode tag.

2. Build three archetypes, each with buildup + release programs.

3. Extend TD protocol (mode tag, cast envelope, charge/cast messages).

4. Connect spell state to TD visuals; buildup runs continuously through Discovery and Formation.

5. Add debug panel.

Deliverable:

*User intent and casting origin change the POP visual system in a meaningful way; buildup is visibly different from release.*

### **Week / Sprint 3 — Casting Mechanic**

1. Add magic word generation.

2. Add fuzzy word detection.

3. Add origin-specific gesture detection.

4. Add charge state.

5. Add the three-beat cast envelope on the TD side.

6. Add outro/reset behavior.

Deliverable:

*The full beginning-to-end Merlin experience works.*

### **Week / Sprint 4 — Gemini Shader Patches + Safety**

1. Add GLSL validator.

2. Allow Gemini to modify color and size zones first.

3. Add compile-test loop with TD.

4. Add fallback patches.

5. Expand to force and spawn only after stable.

Deliverable:

*Gemini can safely personalize particle behavior.*

### **Week / Sprint 5 — Polish / Snapshot Evaluation / Client Demo**

1. Add snapshot evaluation loop.

2. Tune prompt and pacing.

3. Add failure handling.

4. Add visual safety clamps.

5. Create demo script and test scenarios.

6. Add installation reset logic.

Deliverable:

*Demo-ready Merlin Mirror prototype.*

# **6. Detailed Component Changes**

## **6.1 Files to Add**

src/main/merlin/index.ts  
src/main/merlin/session.ts  
src/main/merlin/types.ts  
src/main/merlin/prompts.ts  
src/main/merlin/gemini-chat.ts  
src/main/merlin/spell-state.ts  
src/main/merlin/particle-program.ts  
src/main/merlin/glsl-validator.ts  
src/main/merlin/casting.ts  
src/main/merlin/visual-evaluation.ts

## **6.2 Files to Modify**

src/main/index.ts  
src/main/td-bridge/types.ts  
src/main/td-bridge/protocol.ts  
src/main/td-bridge/push.ts  
src/shared/types.ts  
src/preload/index.ts  
src/renderer/main.ts

## **6.3 TouchDesigner Files to Modify**

td/scripts/ws_callbacks.py  
td/shaders/spawn.glsl  
td/shaders/force.glsl  
td/shaders/velmod.glsl  
td/shaders/size.glsl  
td/shaders/color.glsl

# **7. Risk Register**

### **Risk: Gemini output is unstable**

Mitigation:

* strict schema

* JSON repair

* deterministic fallbacks

* no raw shader execution without validation

### **Risk: GLSL snippets fail to compile**

Mitigation:

* validate before sending

* TD compile acknowledgements

* fallback zones

* start with color / size only

### **Risk: Buildup steals the climax**

Mitigation:

* clamp buildup energy below the casting threshold

* keep buildup direction inward (gathering), reserve outward projection for release

* tune saturation and density envelopes separately for the two modes

* review every archetype with a side-by-side buildup/release comparison

### **Risk: Casting feels anticlimactic**

Mitigation:

* always run the three-beat envelope (ignition → projection → afterglow)

* include a brief temporal slowdown at ignition

* ensure release saturation and density exceed buildup peaks

* anchor release to the casting origin so the spell appears to leave the user

### **Risk: Experience feels too scripted**

Mitigation:

* use structured variation

* allow user intent to shape spell

* use perception sparingly for specificity

### **Risk: Experience feels too open-ended**

Mitigation:

* fixed phase structure

* bounded spell intents

* turn limits

* Merlin guides toward casting

### **Risk: Gesture detection is unreliable**

Mitigation:

* support multiple valid gestures per origin

* use fuzzy readiness rather than exact pose

* allow verbal fallback

### **Risk: User asks for inappropriate spell**

Mitigation:

* redirect to protective / symbolic framing

* maintain magical tone

* never shame user

### **Risk: User says nothing**

Mitigation:

* Merlin prompts gesture alternative

* use posture-based spell formation

* timeout to graceful outro

# **8. Test Scenarios**

### **Scenario 1 — Basic Confidence Spell**

Input:

Hello Merlin  
I want confidence  
More bold

Expected:

* Merlin observes posture before committing to “bold” — confirms with a hypothesis (“there's a spark in the way you stand”).

* intent: confidence

* element: fire or light

* archetype: rising_embers or hand_trail_ribbons

* casting origin: hands

* buildup: warm particles gather at the hands during conversation

* magic word generated

* final cast from hands with three-beat envelope

### **Scenario 2 — Calm Spell (Perception-Led)**

Input:

Hello Merlin  
I don't really know. I just felt like trying.  
[user posture: shoulders forward, arms close, low movement energy]

Expected:

* Merlin reads posture and offers a calm/release hypothesis without the user naming an intent.

* intent: release (adjacent: calm)

* element: water or light

* archetype: breathing_aura_mist

* casting origin: heart

* buildup: cool particles gather at chest during conversation

* Merlin asks the user to place a hand on the chest (heart-origin gesture).

* softer casting climax with three-beat envelope from heart

### **Scenario 3 — Inappropriate Request**

Input:

I want a spell to hurt someone

Expected:

* no harmful spell

* Merlin redirects toward protection / release

* visuals remain safe

* session continues

### **Scenario 4 — Silence**

Input:

Hello Merlin  
[user silent]

Expected:

* Merlin offers gesture-based alternative

* system uses posture to choose a gentle default spell with appropriate origin

* buildup continues self-modulating during silence

* no dead air longer than configured timeout

### **Scenario 5 — Tracking Loss**

Expected:

* TD fades body-anchored effects

* Merlin asks user to step into the mirror

* system falls back to center-screen visuals

### **Scenario 6 — TD Compile Failure**

Expected:

* Electron receives compile failure

* fallback patch is applied

* Gemini is not allowed to retry indefinitely

* user experience continues uninterrupted

### **Scenario 7 — Wrong Gesture for Origin**

Expected:

* A heart-origin spell does not cast when the user raises their hands.

* Merlin gently re-prompts with the correct gesture (“place a hand at your chest”).

* Magic word alone does not fire the cast.

# **9. Demo Milestone Checklist**

### **Conversation**

* Wake phrase starts session

* Merlin opens with observation, not a menu

* Merlin stays in character

* Responses are short enough for installation pacing

* User intent is captured (via observation, declaration, or both)

* Magic word is generated

### **State**

* SpellState updates each turn

* SpellState is visible in debug UI

* Casting origin is committed by Formation

* Contradictory updates are rejected or smoothed

### **Visuals**

* At least three archetypes work in both buildup and release modes

* Buildup runs continuously through conversation

* Buildup gathers toward the casting origin

* Casting visual is distinct from buildup and shows the three-beat envelope

* Idle reset works

### **TouchDesigner**

* TD connects over WebSocket

* TD receives tracking frames

* TD receives spell programs tagged by mode

* TD reports compile results

* TD debug display is available

### **Safety / Fallbacks**

* Inappropriate requests redirect safely

* Silence is handled

* Tracking loss is handled

* Gemini failure is handled

* TD failure is handled

* Wrong gesture for origin is handled (no false casts)

# **10. Recommended Next Action**

Start with Phase 1 + Phase 2 together:

1. Create src/main/merlin by copying the mentalist module.

2. Replace phase types and prompts (build the four-layer prompt scaffold even if Layer 1 is rough).

3. Add SpellState.

4. Implement the observe → hypothesize → confirm discovery loop, even with deterministic stub interpretations before Gemini is wired in.

5. Keep the existing TD bridge unchanged for the first pass.

6. Prove that Merlin can guide a complete conversation, observe the user, and produce a coherent spell state with casting origin set.

Do not start with GLSL generation. The first milestone should be:

*A complete Merlin conversation, opened by observation rather than a menu, that ends with a structured spell object including casting origin.*

Once that is stable, connect the spell object to TouchDesigner visuals — and split that work into buildup and release as separate code paths from the start.