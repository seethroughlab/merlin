/**
 * Conversation Test Presets
 *
 * Hand-written participant characters + multi-turn scripts for the
 * Conversation tab of the Shift+T test panel. Each preset is a plausible
 * 4-5 turn conversation that should carry Merlin from discovery →
 * formation → ready_to_cast. The dev (or Claude) can pick one to walk
 * the entire flow in seconds, bypassing Whisper STT and the live mic.
 *
 * The optional `expectedSpell` hint is for human evaluation only — the
 * runner does NOT assert on it. It documents the energy Claude expects
 * Merlin to land on so the resulting transcript can be eyeballed.
 *
 * `expectedFace` / `expectedBody` replace the per-turn MediaPipe +
 * analyzeMicroExpressions output that the live mic path produces. The
 * runner pushes them via merlinUpdateAnalysis before each turn so
 * Gemini sees the character's emotional + postural state, closing the
 * test/live parity gap for everything except sub-turn-level face
 * gesture edge events.
 *
 * Special script lines:
 * - `[CAST]` fires `merlinTriggerCast` directly (skips Gemini).
 * - `[END]`  fires `merlinTriggerEnd`.
 */

import type { ConversationTestPreset } from './types';

export const CONVERSATION_TEST_PRESETS: ConversationTestPreset[] = [
  {
    id: 'maya-blocked',
    label: 'Maya — blocked artist',
    description: 'Maya, a painter who hasn\'t made anything new in months. Feels stuck, dry, like the well is empty.',
    expectedSpell: { intent: 'creativity', element: 'cosmic' },
    expectedFace: {
      primaryEmotion: 'numbness',
      secondaryEmotion: 'longing',
      valence: -0.2,
      arousal: 0.25,
      confidence: 0.8,
      description: 'flat affect, eyes unfocused, mouth slightly downturned',
    },
    expectedBody: {
      primaryPosture: 'collapsed inward, shoulders rounded',
      openness: 0.2,
      tension: 0.5,
      engagement: 0.35,
      movementLevel: 0.15,
      gestureTypes: ['arms crossed', 'gaze down'],
      confidence: 0.8,
      observations: ['holding very still', 'not making eye contact'],
      description: 'closed, low-energy posture — like someone trying not to take up space',
    },
    script: [
      "I haven't been able to make anything new in months. I just stare at the canvas.",
      "I used to feel like there was something coming through me. Now there's just nothing.",
      "I don't know — maybe I want to feel like I have access to that again. Whatever that was.",
      "Yeah, like a door cracking open. Just enough light to see by.",
      "[CAST]",
    ],
  },
  {
    id: 'sarah-phd',
    label: 'Sarah — just finished her PhD',
    description: 'Sarah, who just defended her dissertation after six years. Relief and disbelief mixed together. Doesn\'t quite know what to do with the joy yet.',
    expectedSpell: { intent: 'joy', element: 'fire' },
    expectedFace: {
      primaryEmotion: 'relief',
      secondaryEmotion: 'joy',
      valence: 0.6,
      arousal: 0.55,
      confidence: 0.85,
      description: 'wide eyes, half-smile that keeps reappearing — like she keeps forgetting and remembering it\'s real',
    },
    expectedBody: {
      primaryPosture: 'upright, leaning slightly forward',
      openness: 0.7,
      tension: 0.35,
      engagement: 0.8,
      movementLevel: 0.4,
      gestureTypes: ['hands lifted', 'small head shake'],
      confidence: 0.85,
      observations: ['restless hands', 'kept catching her own breath'],
      description: 'post-stress unwind — body still buzzing but clearly opening up',
    },
    script: [
      "I just defended my dissertation. Six years and it's done.",
      "It hasn't actually hit me yet. I keep waiting for someone to say I have to do more revisions.",
      "I think I want to celebrate. I want to actually feel it.",
      "Bright. Hot. Like a bonfire I built myself.",
      "[CAST]",
    ],
  },
  {
    id: 'james-courage',
    label: 'James — hard conversation tomorrow',
    description: 'James has to tell his father tomorrow that he\'s leaving the family business. Has been rehearsing it for weeks. Wants steadiness, not bravado.',
    expectedSpell: { intent: 'confidence', element: 'earth' },
    expectedFace: {
      primaryEmotion: 'determination',
      secondaryEmotion: 'apprehension',
      valence: -0.1,
      arousal: 0.5,
      confidence: 0.8,
      description: 'jaw set, brow slightly lowered — steady eye contact but tightness around the mouth',
    },
    expectedBody: {
      primaryPosture: 'feet planted, shoulders set, chest still',
      openness: 0.55,
      tension: 0.65,
      engagement: 0.7,
      movementLevel: 0.2,
      gestureTypes: ['hands clasped low', 'occasional deep breath'],
      confidence: 0.8,
      observations: ['standing very grounded', 'shoulders held tight'],
      description: 'composed but loaded — bracing for something rather than relaxed',
    },
    script: [
      "I have to tell my dad I'm leaving the family business tomorrow.",
      "He's going to be hurt. I've been the one who was supposed to take it over.",
      "I'm not scared exactly. I just want to stay in my own feet when I'm in the room.",
      "Something steady. Like standing on stone, not balancing on a wire.",
      "[CAST]",
    ],
  },
  {
    id: 'tom-anxious',
    label: 'Tom — can\'t sleep, work spiraling',
    description: 'Tom is awake at 2am replaying a meeting he has tomorrow. Mind won\'t let go. Wants release, not escape.',
    expectedSpell: { intent: 'release', element: 'water' },
    expectedFace: {
      primaryEmotion: 'anxiety',
      secondaryEmotion: 'fatigue',
      valence: -0.4,
      arousal: 0.7,
      confidence: 0.85,
      description: 'tight brow, eyes darting, slight tremor in the lower lip — tired but wired',
    },
    expectedBody: {
      primaryPosture: 'shoulders raised, hands restless',
      openness: 0.3,
      tension: 0.85,
      engagement: 0.6,
      movementLevel: 0.5,
      gestureTypes: ['hand to neck', 'rubbing face', 'shifting weight'],
      confidence: 0.85,
      observations: ['can\'t stop fidgeting', 'jaw clenched between sentences'],
      description: 'high-tension, exhausted body that can\'t find rest',
    },
    script: [
      "I keep playing tomorrow's meeting over and over in my head at 2am.",
      "I've been like this for three nights now. Every loop tightens another notch.",
      "I just want to put it down. Not solve it — put it down.",
      "Yeah. Like rain washing the road clean. Whatever was stuck there, gone.",
      "[CAST]",
    ],
  },
  {
    id: 'aria-curious',
    label: 'Aria — something new, undefined',
    description: 'Aria met someone recently and is trying to figure out what she\'s feeling. Not heavy — open, slightly amused at herself, curious.',
    expectedSpell: { intent: 'wonder', element: 'air' },
    expectedFace: {
      primaryEmotion: 'curiosity',
      secondaryEmotion: 'amusement',
      valence: 0.45,
      arousal: 0.5,
      confidence: 0.85,
      description: 'soft smile, raised brows, head tilted slightly — looking off when she thinks of them',
    },
    expectedBody: {
      primaryPosture: 'relaxed, head slightly tilted',
      openness: 0.75,
      tension: 0.25,
      engagement: 0.75,
      movementLevel: 0.3,
      gestureTypes: ['hand to chin', 'gentle sway'],
      confidence: 0.85,
      observations: ['light on her feet', 'amused with herself'],
      description: 'open, exploratory body language — no defensiveness, just curiosity',
    },
    script: [
      "There's someone new in my life and I'm trying to figure out what I feel.",
      "It's not big yet. It's small and kind of fluttery and I keep thinking about them at weird moments.",
      "I don't want to name it. I just want to look at it for a minute.",
      "Something light. Like a moth circling a streetlight, just looking.",
      "[CAST]",
    ],
  },
  {
    id: 'david-grief',
    label: 'David — grief, learning to carry it',
    description: 'David lost his father a month ago. The acute shock has passed; now he\'s figuring out how to keep moving while the loss is permanent.',
    expectedSpell: { intent: 'transformation', element: 'cosmic' },
    expectedFace: {
      primaryEmotion: 'sorrow',
      secondaryEmotion: 'tenderness',
      valence: -0.3,
      arousal: 0.3,
      confidence: 0.85,
      description: 'eyes a little glassy, faint warm smile when he thinks of his father — sorrow carried gently, not raw',
    },
    expectedBody: {
      primaryPosture: 'shoulders softened, head slightly bowed',
      openness: 0.5,
      tension: 0.45,
      engagement: 0.55,
      movementLevel: 0.2,
      gestureTypes: ['hand to chest', 'slow breathing'],
      confidence: 0.85,
      observations: ['moves slowly and deliberately', 'pauses between thoughts'],
      description: 'inward, contemplative — not collapsed, but quiet',
    },
    script: [
      "My dad died last month. It hasn't stopped being true yet.",
      "I keep reaching for the phone to call him. Then I remember.",
      "I'm not trying to fix it — I know that's not how this works. I just want to find a way to carry him with me.",
      "Something that holds him. Like a star I can look at when it's dark.",
      "[CAST]",
    ],
  },
  {
    id: 'elena-protection',
    label: 'Elena — needs to hold her ground',
    description: 'Elena is being undermined by a colleague at work. There\'s a meeting tomorrow where she needs to stand firm without escalating.',
    expectedSpell: { intent: 'protection', element: 'earth' },
    expectedFace: {
      primaryEmotion: 'resolve',
      secondaryEmotion: 'frustration',
      valence: -0.2,
      arousal: 0.6,
      confidence: 0.85,
      description: 'level gaze, jaw firm — not angry, but very clearly done being pushed',
    },
    expectedBody: {
      primaryPosture: 'squared shoulders, feet planted wide',
      openness: 0.5,
      tension: 0.7,
      engagement: 0.8,
      movementLevel: 0.25,
      gestureTypes: ['hands on hips', 'chin raised'],
      confidence: 0.85,
      observations: ['takes up more space than usual', 'voice steady'],
      description: 'grounded, defended posture — like she\'s already standing in the meeting',
    },
    script: [
      "There's a colleague who keeps taking credit for my work. I have a meeting with him and our boss tomorrow.",
      "I've been polite about it for three months. That ends tomorrow.",
      "I don't want to attack him. I just want to be undeniable. Like I can't be moved.",
      "A wall around me. Not aggressive — just there. Solid.",
      "[CAST]",
    ],
  },
  {
    id: 'marcus-burnout',
    label: 'Marcus — burned out, going through the motions',
    description: 'Marcus has been pushing too hard for too long. He\'s flat, on autopilot, no spark — needs a wake-up, not more rest.',
    expectedSpell: { intent: 'clarity', element: 'fire' },
    expectedFace: {
      primaryEmotion: 'numbness',
      secondaryEmotion: 'exhaustion',
      valence: -0.15,
      arousal: 0.2,
      confidence: 0.85,
      description: 'flat expression, half-lidded eyes — not sad, just not really there',
    },
    expectedBody: {
      primaryPosture: 'slumped, weight on one hip',
      openness: 0.35,
      tension: 0.4,
      engagement: 0.3,
      movementLevel: 0.1,
      gestureTypes: ['hand rubbing back of neck', 'long blinks'],
      confidence: 0.85,
      observations: ['low energy', 'voice almost monotone'],
      description: 'low-arousal, disengaged body — the body of someone running on fumes',
    },
    script: [
      "I haven't taken a real day off in eight months. I don't even know if I like my job anymore.",
      "Everyone keeps telling me to rest, but rest isn't the thing. I sleep nine hours and wake up feeling the same.",
      "I think I need to feel something again. Anything. A jolt.",
      "Like striking a match in the dark. Sharp. Bright. Just enough to remember what light looks like.",
      "[CAST]",
    ],
  },
  {
    id: 'priya-audition',
    label: 'Priya — audition tomorrow, wants focus',
    description: 'Priya has an audition tomorrow that matters a lot. She doesn\'t need confidence — she has it — she needs to drop into pure attention and not get scattered.',
    expectedSpell: { intent: 'focus', element: 'air' },
    expectedFace: {
      primaryEmotion: 'anticipation',
      secondaryEmotion: 'composure',
      valence: 0.25,
      arousal: 0.55,
      confidence: 0.85,
      description: 'soft inward smile, eyes steady — already half-rehearsing in her head',
    },
    expectedBody: {
      primaryPosture: 'tall, weight centered',
      openness: 0.6,
      tension: 0.4,
      engagement: 0.75,
      movementLevel: 0.2,
      gestureTypes: ['slow inhale', 'hands lightly clasped'],
      confidence: 0.85,
      observations: ['breathing deeply', 'very contained energy'],
      description: 'gathered, prepared body — like she\'s already on the mark',
    },
    script: [
      "I have an audition tomorrow that I've been working toward for two years.",
      "I'm not nervous exactly. I just don't want the noise — there's so much I could spiral about if I let myself.",
      "I want to walk in and be one clean line of attention. No static.",
      "Like a held breath. Quiet. Pointed.",
      "[CAST]",
    ],
  },
  {
    id: 'noor-heartbreak',
    label: 'Noor — heartbreak, wondering if she can love again',
    description: 'Noor\'s long relationship ended six weeks ago. She\'s past the worst of it but tender, and questioning whether she can open up again.',
    expectedSpell: { intent: 'transformation', element: 'water' },
    expectedFace: {
      primaryEmotion: 'tenderness',
      secondaryEmotion: 'wistfulness',
      valence: -0.15,
      arousal: 0.35,
      confidence: 0.85,
      description: 'soft eyes, slight melancholy at the mouth — gentle, not crying',
    },
    expectedBody: {
      primaryPosture: 'arms loosely wrapped around herself',
      openness: 0.4,
      tension: 0.4,
      engagement: 0.55,
      movementLevel: 0.2,
      gestureTypes: ['hand on opposite arm', 'gentle rocking'],
      confidence: 0.85,
      observations: ['self-soothing posture', 'voice softer than usual'],
      description: 'tender, semi-closed body — like someone protecting a healing place',
    },
    script: [
      "We broke up six weeks ago. I'm not destroyed anymore, but I'm not whole either.",
      "I keep wondering if the version of me that could love that way is just gone now.",
      "I don't want to be guarded forever. I want to find out if I can soften again. Slowly.",
      "Like a river that froze and is starting to move under the ice.",
      "[CAST]",
    ],
  },
];
