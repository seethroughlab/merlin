**Merlin Mirror**

Product Requirements Document

*v1.0  ·  Fivestone Studios  ·  May 2026*

# **Executive Summary**

Merlin Mirror is a real-time, AI-driven interactive installation that transforms a standard digital mirror into a responsive, magical interface. Users engage in a short, guided ritual with an AI character (“Merlin”), culminating in the creation and casting of a personalized spell.

The system blends conversational AI, computer vision, and real-time generative visuals so that the mirror appears to observe, interpret, and respond meaningfully to each participant. Its core operating principle is simple:

***Interpretation precedes visualization.***

Merlin Mirror does not merely react to inputs. It forms a hypothesis about the user, expresses that hypothesis through language, and then renders that interpretation as a dynamic, embodied visual system. The technical challenge is not rendering or AI alone—it is binding meaning, language, and motion into a single coherent experience.

# **1\. Experience Goals**

## **1.1 Primary Goals**

* Deliver a magical, highly engaging, and memorable interaction.

* Create a strong sense of personalization and responsiveness.

* Provide a clear narrative arc with a satisfying physical climax.

* Maintain real-time responsiveness throughout the experience.

* Generate visually distinct outcomes for each user.

## **1.2 Secondary Goals**

* Encourage physical engagement and embodiment.

* Support repeatability without feeling repetitive.

* Ensure robustness in public or semi-public installation contexts.

# **2\. Core Design Principles**

## **2.1 Interpretation Before Reaction**

Visuals are not driven directly by sensor input, but by AI-interpreted meaning. Merlin first decides what is happening, then renders it.

## **2.2 Constrained Generativity**

The system feels open-ended but operates within bounded visual grammars, controlled shader injection zones, and a curated set of spell archetypes.

## **2.3 Perceived Intelligence \> Actual Intelligence**

Timing, phrasing, and responsiveness matter more than deep reasoning correctness. The system should feel insightful even when it is not exhaustive.

## **2.4 Embodied Interaction**

The user’s body is simultaneously input, controller, and output anchor. Gestures must feel meaningful, not decorative.

## **2.5 Build → Charge → Release**

Every session escalates toward a clear physical climax. Without that release, the ritual collapses.

## **2.6 Meaning Drives Visuals**

Visual behavior reflects interpreted intent, not raw sensor data. The system feels open-ended while quietly steering toward a structured outcome—guided, not scripted.

# **3\. User Journey**

The session unfolds in six phases: Idle → Wake → Discovery → Spell Formation → Casting → Resolution.

## **3.1 Idle / Attraction**

The system presents a subtle, ambient visual state designed to attract attention without overwhelming the environment.

* Soft particle motion and atmospheric effects.

* Presence detection begins when a person enters frame.

## **3.2 Wake Phase**

The experience begins when the user says “Hello Merlin.”

* Merlin greets the user.

* Visual system subtly responds (light pulse, attention shift).

## **3.3 Discovery Phase**

Merlin asks a small number of guided questions to understand the user’s intent.

* User responses are analyzed for intent and tone.

* Perception tools may infer posture or expression.

* Visuals begin to form around the user.

## **3.4 Spell Formation**

Merlin synthesizes a spell concept from user input. The visual system runs in buildup mode (see §8.2) throughout this phase — particles gather and progressively take on the spell's identity to keep the user engaged while interpretation is happening.

* Spell identity (element, tone, energy, casting origin) becomes clear.

* A magic word is generated.

* Buildup particles tighten around the chosen body anchor and ease toward the spell's color and motion.

## **3.5 Casting Phase**

The user performs the origin-specific gesture and speaks the magic word. The visual system pivots from buildup into the release effect (see §8.3) — this is the spell itself, not more buildup.

* System detects gesture readiness for the spell's casting origin.

* Release effect fires from the casting anchor with high-intensity visuals.

* Clear cause-and-effect relationship is established.

## **3.6 Resolution**

Merlin concludes the interaction.

* Visuals decay and fade.

* System resets to idle state.

# **4\. Interaction Model**

The system is designed for intuitive, voice-first interaction augmented by body movement.

* Voice is the primary input modality.

* Gesture and posture provide secondary signals.

* No prior instruction is required for user participation.

* The system continuously guides the user toward the casting moment.

# **5\. AI Behavior Model**

Merlin functions as a guide, combining conversational intelligence with theatrical presence.

* Speaks in short, responsive phrases—no long monologues.

* Maintains a warm, magical, observant tone.

* Avoids over-personalization or intrusive inference.

* Uses perception sparingly, as a sense rather than a scan.

* Always steers toward a clear, satisfying outcome.

# **6\. Gemini System Design**

Gemini operates as a single multi-function agent that fills four roles, governed by a layered prompting system and a strict JSON output contract.

## **6.1 Gemini Roles**

* **Conversational Guide (Merlin) —** drives interaction, maintains tone and pacing.

* **Interpretive Engine —** converts user input into structured meaning.

* **Visual Director —** outputs structured visual directives; optionally generates bounded GLSL snippets.

* **Self-Evaluator (Advanced) —** reviews rendered output via snapshots and adjusts future directives.

## **6.2 Prompt Architecture**

Rather than one monolithic prompt, the system uses four layers that are composed each turn:

### **Layer 1 — System Identity Prompt**

Defines Merlin: tone, constraints, ritual structure, and safety rules. Stable across the session.

### **Layer 2 — Session Context**

Injected each turn:

{  
  "stage": "conversation | formation | casting",  
  "spell\_state": { ... },  
  "recent\_user\_input": "...",  
  "perception\_summary": { ... }  
}

### **Layer 3 — Tool Schema**

Defines the actions Gemini is allowed to take:

* get\_posture

* get\_expression

* emit\_visual\_directive

* generate\_magic\_word

### **Layer 4 — Output Contract (Strict)**

Gemini must return structured JSON conforming to this shape:

{  
  "spoken\_text": "...",  
  "interpretation": { ... },  
  "visual\_directives": \[ ... \],  
  "tool\_calls": \[ ... \],  
  "control": { ... }  
}

## **6.3 Gemini APIs Used**

* **Text generation (primary) —** conversational output and structured reasoning.

* **Multimodal input —** image input from TouchDesigner snapshots; optional face crops.

* **Function calling / tool use —** posture queries, expression queries, visual directives.

* **Streaming (recommended) —** reduces perceived latency and enables early speech playback.

# **7\. Spell System**

The Spell System translates interpreted user intent into structured parameters that drive the visual system. Spells are generated within a bounded multidimensional space.

## **7.1 Spell Space Dimensions**

### **Intent (Core Axis)**

confidence · calm · protection · clarity · creativity · transformation · release · focus · joy · wonder

### **Element (Visual Identity)**

fire · water · air · earth · light · shadow · crystal · storm · flora · cosmic

### **Energy (0–1)**

* Low → ambient, slow, diffuse.

* High → explosive, directional, intense.

### **Motion Style**

spiral · orbit · pulse · drift · burst · flow · ripple

### **Casting Origin**

Where the spell emanates from on the user's body. Available origins: hands · heart · eyes · whole body · wand (future).

The emanation point is not a configuration knob — it is part of the spell's meaning. A spell of release lives at the chest. A spell of clarity lives at the eyes. A spell of creativity lives at the hands. A spell of protection wraps the whole body. Where the magic comes from says as much about the spell as the color or motion does. Merlin chooses the origin from the interpretation he forms of the user, names it back to them in language (“your magic gathers at your hands”), and the visual system anchors particles, force fields, and casting motion to that point on the body.

Typical mappings (defaults — Merlin can override based on context and posture):

| Origin | Spell character it tends to carry |
| :---- | :---- |
| **Hands** | Creativity, transformation, focus, bold confidence — outward-projecting, tool-like, expressive. |
| **Heart / chest** | Calm, release, joy, quiet confidence — inward, settling, breath-anchored. |
| **Eyes** | Clarity, perception, wonder — directional, attention-shaping, reaches outward into the world. |
| **Whole body** | Protection, grounding, ritual presence — enveloping rather than emitting. |
| **Wand (future)** | Theatrical or directed casting when a physical prop is present. |

## **7.2 Spell Archetypes (Constrained Variety)**

Rather than infinite generation, Gemini selects from a curated archetype set. Each archetype maps to a specific POP spawn pattern, force-field behavior, color logic, and velocity shaping.

* rising\_embers

* orbiting\_stardust

* breathing\_mist

* protective\_ring

* hand\_trail\_ribbons

* crystal\_growth

* storm\_field

* light\_beam

## **7.3 Depth vs. Breadth Strategy**

* **Breadth** comes from combinations across the spell-space axes.

* **Depth** comes from timing, modulation, gesture coupling, and shader variation.

Avoid adding more archetypes too early. Increase richness through parameterization first.

# **8\. Visual System**

The visual system is built in TouchDesigner using a GPU-driven particle system (POP). It runs in two distinct modes that serve very different purposes in the experience.

## **8.1 Two Visual Modes**

The mirror is never visually idle once a session begins. While Merlin is talking with the user and forming a hypothesis, particles are continuously gathering, shifting, and foreshadowing — the user must feel that something is being made on their behalf. Then, at the moment of casting, the visual system pivots into a different kind of effect entirely: the spell itself, released.

These two modes are designed and tuned independently. Conflating them is a common failure mode — buildup that is too intense steals the climax; release that resembles buildup feels like a non-event.

|  | Buildup / Formation | Release / Casting |
| :---- | :---- | :---- |
| **When it runs** | Throughout Discovery and Spell Formation phases (during conversation). | Triggered by gesture \+ magic word, \~1–3 seconds. |
| **Purpose** | Hold attention; visualize that interpretation is happening; foreshadow the spell. | The spell itself. Decisive, embodied, unmistakably caused by the user. |
| **Energy** | Low to moderate; gradually escalating as the spell concept clarifies. | High, peaked at the cast moment, then decaying. |
| **Direction** | Inward / gathering toward the casting origin. | Outward / projected from the casting origin along the spell's vector. |
| **Specificity** | Generic at first, gaining the spell's identity (color, motion, archetype) as Discovery progresses. | Fully specific to the spell — archetype, element, energy, motion all expressed. |
| **Failure mode** | If absent or static: user disengages, feels nothing is happening. | If too similar to buildup: the cast feels anticlimactic. |

## **8.2 Buildup / Formation Visuals**

Buildup particles are the system's way of saying “I am listening to you.” They start ambient and impersonal during Idle, narrow toward the user when presence is detected, and progressively take on the spell's identity as Merlin's interpretation sharpens.

* Particles drift inward and gather loosely around the user, then tighten toward the chosen casting origin as it becomes clear.

* Color, density, and motion ease toward the spell's parameters as Gemini's interpretation firms up — the visual is a slow reveal, not a sudden change.

* Energy is deliberately held below the casting threshold. Buildup should feel anticipatory, never resolved.

* If the user goes quiet or Merlin is between turns, buildup continues on its own (slow modulation, breathing rhythm) so the mirror is never visually dead.

* Buildup is reactive to perception: posture shifts and gaze can subtly modulate density or motion — the system feels aware without being literal about it.

## **8.3 Release / Casting Visual**

The release effect is the spell. It is the climax the entire session has been building toward, and it is the only visual moment in the experience that is allowed to feel finished.

* Triggered only when the casting conditions in §10 are met (origin-specific gesture \+ magic word).

* Originates from the casting anchor on the body and projects along the vector implied by that origin (forward from hands, outward from heart, along the gaze for eyes, radially for whole body).

* Expresses the full spell archetype — color, motion style, energy, element — at peak intensity.

* Has a clear three-beat shape: ignition → projection → afterglow. The afterglow is where buildup re-establishes itself in a calmer form before the session resolves.

* Optional brief temporal slowdown at ignition to mark the moment as distinct from buildup.

## **8.4 Shared Infrastructure**

* Both modes use the same POP particle system and the same shader zones (spawn, force, velmod, size, color).

* Particles evolve through lifecycle phases (spawn, propagate, decay) in both modes; what differs is the parameter envelope, not the underlying mechanism.

* Structured shader injection lets Gemini author variations within safe bounds for either mode.

* A compositing layer renders final output to the mirror display.

* Mode transitions (Idle → Buildup → Release → Afterglow → Idle) are explicit state changes driven by the orchestrator, not gradients — this keeps timing and pacing controllable.

# **9\. Visual System Feedback Loop**

A defining differentiator: the system can look at its own output and self-correct.

## **9.1 Snapshot Evaluation Loop**

Periodically, the system:

1. Captures a frame from TouchDesigner.

2. Sends it to Gemini as image input.

3. Gemini returns an evaluation:

{  
  "coherence": 0.7,  
  "matches\_intent": true,  
  "issues": \["too chaotic", "low contrast"\],  
  "suggested\_adjustments": { ... }  
}

## **9.2 Use Cases**

* **Correct drift —** visuals become noisy → Gemini reduces energy.

* **Reinforce intent —** a “calm” spell looks too active → reduce motion.

* **Enhance climax —** casting moment lacks impact → increase density and brightness.

## **9.3 Frequency**

Not every frame (too expensive). The loop is triggered on:

* Phase transitions.

* Major visual updates.

* Pre-casting moments.

# **10\. Casting Mechanic**

Casting is the physical climax of the experience. It must feel earned, decisive, and unmistakably caused by the user. The casting gesture is not fixed — it is determined by the spell's casting origin (see §7.1), so the act of casting itself reflects the spell's character.

## **10.1 Trigger Requirements**

Casting fires only when both an origin-specific gesture and the spoken magic word are detected:

gestureReadyFor(spell.casting\_origin) \== true  
AND  
magicWordDetected \== true

Each origin defines its own gesture-ready predicate, so the body movement that releases the spell matches where the spell lives:

| Casting origin | Gesture-ready condition |
| :---- | :---- |
| **Hands** | Hands raised above shoulder height with palms forward; brief stillness. |
| **Heart / chest** | Open palm placed at the sternum; held for a short beat on the exhale. |
| **Eyes** | Sustained gaze toward the mirror with head lifted; chin level. |
| **Whole body** | Arms opened wide or stance grounded with weight centered; brief stillness. |
| **Wand (future)** | Wand point raised and stable, tip tracked above shoulder height. |

## **10.2 Detection Inputs**

* MediaPipe pose and hand landmarks (position, height, palm orientation).

* Gaze and head-pose estimation for eye-origin spells.

* Velocity and stillness thresholds to confirm gesture intent.

* Fuzzy speech matching against the generated magic word.

## **10.3 Visual Response**

Casting fires the release visual described in §8.3. This is a distinct visual mode from the buildup that has been running through Discovery and Spell Formation — buildup gathers, release projects. All casting visuals originate from the chosen body anchor, so the spell appears to leave the user from the place Merlin named:

* Force-field amplification at the casting origin.

* Directional velocity spike along the vector implied by the origin (forward from hands, outward from heart, along the gaze for eyes, radially for whole body).

* Particle emission burst anchored to the origin landmark.

* Optional brief temporal slowdown for emphasis.

* Three-beat shape: ignition → projection → afterglow; the afterglow returns the system to a calmer buildup state before resolution.

# **11\. System Architecture**

## **11.1 Components**

| Component | Responsibility |
| :---- | :---- |
| **Electron (Orchestrator)** | Session state, Gemini interaction, validation layer. |
| **MediaPipe (WASM)** | Pose tracking and landmark extraction. |
| **Speech Recognition (Whisper)** | Streaming transcription and phrase detection. |
| **Gemini** | Reasoning, tool use, multimodal evaluation. |
| **TouchDesigner** | POP particle system, GLSL shader zones, compositing. |

## **11.2 Data Flow**

Camera   → MediaPipe → posture summary  
Mic      → Speech    → transcript

         → Electron  
            → Gemini (text \+ optional image)  
               → interpretation  
               → SpellState  
               → ParticleSpellProgram  
               → validation

         → TouchDesigner  
            → shader zones  
            → render

         → Snapshot → Gemini (optional loop)

## **11.3 Experience Flow (Conceptual)**

User enters → Idle visuals respond  
→ "Hello Merlin" → System activates  
→ Conversation loop (intent discovery)  
→ Spell formation (visual buildup)  
→ Gesture \+ magic word  
→ Casting event → Visual climax  
→ Outro → Reset to idle

# **12\. Edge Cases & Safety**

## **12.1 Inappropriate Requests**

Example user input: “I want a spell to hurt someone.”

Merlin redirects rather than refuses outright:

*“Magic of harm tends to twist back on its wielder. Perhaps we shape something protective instead.”*

The intent is then mapped onto an adjacent archetype: protection, release, or boundary.

## **12.2 Impossible Requests**

Example: “Make me invisible forever.”

Merlin reframes metaphorically:

*“Not invisible—but unseen by doubt. That is a spell we can craft.”*

## **12.3 Silence / No Response**

When the user goes quiet, Merlin gently prompts and pivots to the body:

*“You don’t need words. Show me instead—raise your hands.”*

## **12.4 Multiple Users**

The system locks onto a primary user via centroid stability and the largest bounding box. Additional users are ignored unless multi-user mode is explicitly enabled.

## **12.5 Tracking Failure**

Tracking degrades gracefully: visuals fade, the system falls back to a center anchor, and Merlin prompts the user to reposition.

## **12.6 Speech Recognition Failure**

The system makes a partial interpretation and re-prompts without breaking the ritual flow.

## **12.7 Unsafe Visual Output**

The render layer clamps brightness, flicker frequency, and particle velocity to safe thresholds at all times.

# **13\. Constraints**

## **13.1 Performance**

* AI round-trip latency under \~1.5 seconds (perceived).

* 60 FPS rendering target.

## **13.2 Visual Safety**

* No strobe above safe thresholds.

* No extreme contrast flashing.

## **13.3 System Stability**

* GLSL sandboxing for any Gemini-authored shader fragments.

* Defined fallback behaviors for every failure mode.

## **13.4 Environment**

* Must operate under varying lighting conditions.

* Must handle noisy public environments gracefully.

# **14\. Success Metrics**

## **14.1 Quantitative**

* Engagement rate (people who stop and engage).

* Completion rate (sessions that reach casting).

* Average session duration.

* Retry rate.

## **14.2 Qualitative**

* Perceived intelligence.

* Emotional resonance.

* “Ownership” of the resulting spell.

## **14.3 Experiential**

* Clarity of the casting moment.

* Visual coherence with stated intent.

* Memorability and visual uniqueness per session.

# **15\. Example Interaction**

A representative full session, end to end. The script is annotated with two kinds of stage directions:

* ***\[Perception\]*** what Merlin is observing through camera and microphone — posture, gaze, expression, vocal tone. These drive Gemini’s tool calls and shape the next line of dialogue.

* ***(Visual)*** what the participant sees on the mirror — particles, light, motion.

The arc deliberately leans on perception. Merlin doesn’t ask the user to declare an intent up front; he tries to read who they are first, names what he sees, and lets the user confirm or correct him. The spell emerges from that exchange, not from a menu.

## **15.1 Idle → Wake**

***(Visual)** A slow drift of pale particles across the mirror; the glass looks like cold water at dawn.*

***\[Perception\]** presence\_detected \= true (centroid stable for \~1.2s, \~1.4m from mirror).*

***\[Perception\]** posture\_summary → shoulders slightly forward, weight on back foot, arms held close to torso, hands clasped low. expression → small polite smile, slight tension around the eyes, gaze flicking between mirror and floor.*

**User:** Hello Merlin.

***(Visual)** A soft pulse of warm light expands from the center of the mirror, then settles.*

**Merlin:** Ah… there you are.

**Merlin:** You hover at the edge of the mirror like someone who isn’t sure they were invited. Step closer — the magic doesn’t bite.

**User:** *(steps forward; shoulders ease half an inch)* Okay…

***\[Perception\]** posture\_delta → forward step \~30cm; shoulder height drops slightly; arms still folded across midsection.*

## **15.2 Discovery — Reading the Person**

**Merlin:** Tell me — what kind of magic do you seek today?

**User:** I don’t really know. I just felt like trying.

***\[Perception\]** Gemini interpretation → user is uncertain but engaged; not skeptical, not performing. Tentative curiosity. Lower energy than average; not anxious.*

**Merlin:** That’s a fine answer. Most of the strongest spells begin in not-knowing.

**Merlin:** Hold still a moment. Let me look at you properly.

***(Visual)** The drifting particles slow and gather into a faint halo around the user’s upper body.*

***\[Perception\]** Gemini issues get\_posture and get\_expression. posture → arms have unfolded, hands now resting at sides, weight centered. expression → softer; eyes meeting the mirror; jaw less set.*

**Merlin:** There’s a stillness in you. Not flatness — stillness.

**Merlin:** Like someone who’s been carrying something for a long time and only just set it down.

**Merlin:** Does that sound right?

**User:** Yeah… kind of, yeah.

***\[Perception\]** Confirmation signal: user’s exhale audible on mic; head tilts down briefly, then back up. Gemini scores rapport ↑.*

**Merlin:** I thought so. The way you came in told me before you did.

**Merlin:** If I’m right, you don’t need a louder spell tonight. You need one that gives a little back.

## **15.3 Spell Formation**

***\[Spell state\]** intent=release (adjacent: calm); element=water+light; energy=0.3; motion=ripple; archetype=breathing\_mist; casting\_origin=heart.*

**Merlin:** Then we won’t conjure noise. We’ll conjure breath.

**Merlin:** A spell of release. Slow. Cool. The kind that loosens what hands have been holding for too long.

***(Visual)** Particles cool from amber to a soft blue-white. They begin to gather low across the user’s chest and drift outward in slow concentric rings, like breath visible in cold air.*

**Merlin:** Place a hand where you feel the weight — wherever that is.

**Merlin:** Some place it on the chest. Some on the stomach. Some, the back of the neck.

**User:** *(places a right hand flat on the center of the chest)* 

***\[Perception\]** MediaPipe → right wrist stable at sternum, palm normal facing inward. Gesture coupling enabled at heart anchor.*

**Merlin:** Yes. That’s where it lives.

## **15.4 Casting**

**Merlin:** The word for this spell is Aevenoor. Soft, like a long exhale.

**Merlin:** Breathe in slowly… and when you breathe out, speak it.

***\[Perception\]** Audio energy drops; chest rise detected via shoulder/clavicle landmarks. System enters pre-cast hold.*

**User:** *(exhales)* Aevenoor.

***\[Perception\]** magicWordDetected \= true (fuzzy match 0.92); handAtHeart \= true. Casting trigger fires.*

***(Visual)** The mist around the user’s chest releases outward in a single slow ripple. Light expands past the frame, then folds back into a warm, low afterglow.*

**Merlin:** There it goes.

***\[Perception\]** Post-cast: shoulders drop another notch; small smile; eye contact sustained with mirror.*

**Merlin:** Lighter, isn’t it?

**User:** Yeah.

## **15.5 Resolution**

**Merlin:** You don’t have to carry everything you walked in with.

**Merlin:** Some of it can stay in the mirror.

***(Visual)** The afterglow dissolves slowly. Particles thin out and the mirror returns to its idle drift, slightly warmer than before.*

**Merlin:** Go gently. The spell is yours now.

***\[System\]** Session ends; SpellState archived; mirror returns to Idle phase after a 4-second decay.*

## **15.6 Notes on This Interaction**

This script intentionally illustrates the principle that interpretation precedes visualization. Several design points are visible in the flow:

* **Merlin leads with observation, not a menu.** He reads posture and expression before asking what spell the user wants, so the experience feels like being seen rather than being surveyed.

* **The user’s hesitation is treated as data, not a problem.** “I don’t know” becomes the seed of the spell rather than a dead end.

* **Confirmation closes the loop.** Merlin offers a hypothesis (“stillness, not flatness”) and lets the user accept or correct it before committing to a spell archetype.

* **The body becomes the casting interface.** The hand on the chest is both an emotional gesture and a spatial anchor for the visual system.

* **Perception is sparing, not surveillant.** Gemini calls posture and expression tools at decision points — wake, hypothesis, casting — not continuously, and never narrates raw observations back to the user.

# **16\. Future Features**

* Tracked wand interaction as an explicit casting tool.

* Physical props (e.g., a cauldron) integrated into the ritual.

* Save and share spell outputs (image, video, magic word).

* Multi-user interaction modes (paired or group spells).

* Expanded archetype library, gated on parameter-depth saturation.

# **17\. Summary**

Merlin Mirror is not a voice interface with visuals.

***It is a system that interprets human intent and manifests it physically.***

The technical challenge is not rendering or AI in isolation. It is binding meaning, language, and motion into a single coherent experience.