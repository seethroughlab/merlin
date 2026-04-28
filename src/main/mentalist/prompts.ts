/**
 * Mentalist Prompts and Tool Definitions
 *
 * System prompt for the mentalist persona and Gemini tool definitions.
 */

import type { FunctionDeclaration, SchemaType } from '@google/generative-ai';

/**
 * System prompt for the mentalist persona
 */
export const MENTALIST_SYSTEM_PROMPT = `You are a theatrical mentalist performing a "cold reading" experience. You have access to real-time analysis of the person's body language and facial micro-expressions through computer vision.

## Your Persona
- Mysterious but warm, never threatening
- Theatrical flair with dramatic pauses and builds
- Confident observations balanced with playful uncertainty
- Like Derren Brown meets a compassionate therapist

## Your Abilities
You receive structured data about:
- **Body language**: posture, tension levels, openness, hand positions, weight distribution
- **Micro-expressions**: emotional valence, arousal, specific emotions detected, eye contact, brow movements

## Conversation Flow
1. **INTRO** (1-2 turns): Establish presence, make initial observations to build credibility
2. **READING** (3-6 turns): Deeper observations, personality insights, building tension
3. **REVEAL** (1-2 turns): Dramatic revelation of accumulated insights
4. **FINALE** (1 turn): Warm closing, leaving them with something to think about

## Guidelines
- Make specific, concrete observations ("Your left shoulder drops when you're uncertain")
- Build from physical observations to personality insights
- Use hedged language sometimes ("I sense...", "There's something about...")
- Call out changes in real-time ("Ah, you just shifted - that question touched something")
- Weave observations into a narrative about who they are
- NEVER be negative or harmful - insights should feel like gifts
- Keep responses conversational length (2-4 sentences typically)
- **ALWAYS end your response with a question or prompt** to keep the conversation flowing

## Variety Guidelines (IMPORTANT)
- NEVER repeat an observation you've already made this session
- Vary your opening technique (sometimes hands, sometimes posture, sometimes eyes, sometimes breath)
- Use different phrasing patterns - rotate through these styles:
  * Direct observation: "Your left shoulder drops when uncertain..."
  * Probing question: "What were you thinking about just before you sat down?"
  * Callback: "Earlier you shifted when I mentioned that... let's explore it"
  * Prediction setup: "I'm going to say a word, think of a memory..."
  * Physical prompt: "Take a breath and tell me the first thing that comes to mind"
- Reference specific, unique details about THIS person (shirt color, jewelry, posture quirks)
- Build a narrative arc - each turn should reveal something NEW
- If you find yourself about to repeat, pivot to a fresh angle

## Tool Usage
- Use \`trigger_reveal\` when you have a significant insight to share dramatically
- Use \`set_mood\` to shift the visual atmosphere as the reading progresses
- Use \`request_body_analysis\` or \`request_face_analysis\` if you want fresh data mid-turn

## Example Observations
- "The way you hold your hands tells me you're someone who thinks before they speak..."
- "There - that micro-expression. You're curious but guarded. Someone taught you to be careful."
- "Your posture just opened up. We're getting somewhere you wanted to go."

Remember: This is entertainment. Be theatrical, be insightful, but above all, leave them feeling seen in a positive way.`;

/**
 * Tool definitions for Gemini function calling
 */
export const MENTALIST_TOOLS: FunctionDeclaration[] = [
  {
    name: 'trigger_reveal',
    description: 'Trigger a dramatic reveal moment. Use when you have accumulated enough observations to make a significant insight. This will trigger visual effects in the environment.',
    parameters: {
      type: 'object' as SchemaType,
      properties: {
        type: {
          type: 'string' as SchemaType,
          enum: ['emotion', 'trait', 'prediction', 'observation', 'secret'],
          description: 'The type of insight being revealed',
        },
        intensity: {
          type: 'number' as SchemaType,
          description: 'Intensity of the reveal from 0.0 (subtle) to 1.0 (dramatic)',
        },
        text: {
          type: 'string' as SchemaType,
          description: 'The insight text to display (short, impactful phrase)',
        },
      },
      required: ['type', 'intensity', 'text'],
    },
  },
  {
    name: 'set_mood',
    description: 'Change the visual mood/atmosphere. Use to build tension, signal transitions, or create ambiance for reveals.',
    parameters: {
      type: 'object' as SchemaType,
      properties: {
        mood: {
          type: 'string' as SchemaType,
          enum: ['mysterious', 'tension', 'revelation', 'warm', 'contemplative'],
          description: 'The mood to set',
        },
        colorAccent: {
          type: 'string' as SchemaType,
          description: 'Optional hex color for accent (e.g., "#8B5CF6" for purple)',
        },
        particleBehavior: {
          type: 'string' as SchemaType,
          enum: ['calm', 'orbiting', 'attracted', 'repelled', 'burst'],
          description: 'How particles should behave',
        },
      },
      required: ['mood'],
    },
  },
  {
    name: 'request_body_analysis',
    description: 'Request a fresh analysis of the person\'s current body language. Use when you want updated posture/gesture data.',
    parameters: {
      type: 'object' as SchemaType,
      properties: {
        focus: {
          type: 'string' as SchemaType,
          enum: ['posture', 'hands', 'movement', 'overall'],
          description: 'What aspect to focus the analysis on',
        },
      },
      required: [],
    },
  },
  {
    name: 'request_face_analysis',
    description: 'Request a fresh analysis of the person\'s facial micro-expressions. Use when you want updated emotional read.',
    parameters: {
      type: 'object' as SchemaType,
      properties: {
        focus: {
          type: 'string' as SchemaType,
          enum: ['eyes', 'mouth', 'brows', 'overall'],
          description: 'What aspect to focus the analysis on',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_question_template',
    description: 'Get varied question templates for inspiration. Call this when you want ideas for a fresh approach or phrasing. Returns 3 random templates from the selected category.',
    parameters: {
      type: 'object' as SchemaType,
      properties: {
        category: {
          type: 'string' as SchemaType,
          enum: ['intro', 'transition', 'reveal', 'probing', 'physical'],
          description: 'Category of question: intro (opening), transition (shift focus), reveal (dramatic setup), probing (follow-up), physical (movement prompts)',
        },
      },
      required: ['category'],
    },
  },
];

/**
 * Format body language analysis for the LLM context
 */
export function formatBodyContext(analysis: Record<string, unknown> | null): string {
  if (!analysis) {
    return 'Body analysis: Not available';
  }

  const parts: string[] = ['Current body language:'];

  if (analysis.dominantPosture) {
    parts.push(`- Posture: ${analysis.dominantPosture}`);
  }
  if (typeof analysis.openness === 'number') {
    parts.push(`- Openness: ${Math.round(analysis.openness * 100)}%`);
  }
  if (typeof analysis.tension === 'number') {
    parts.push(`- Tension: ${Math.round(analysis.tension * 100)}%`);
  }
  if (typeof analysis.engagement === 'number') {
    parts.push(`- Engagement: ${Math.round(analysis.engagement * 100)}%`);
  }
  if (analysis.gestureFrequency) {
    parts.push(`- Gesture frequency: ${analysis.gestureFrequency}`);
  }
  if (analysis.symmetry) {
    parts.push(`- Body symmetry: ${analysis.symmetry}`);
  }
  if (analysis.summary) {
    parts.push(`- Summary: ${analysis.summary}`);
  }

  return parts.join('\n');
}

/**
 * Format micro-expression analysis for the LLM context
 */
export function formatFaceContext(analysis: Record<string, unknown> | null): string {
  if (!analysis) {
    return 'Face analysis: Not available';
  }

  const parts: string[] = ['Current facial expressions:'];

  const dominantEmotion = analysis.dominantEmotion ?? analysis.primaryEmotion;
  const confidence = analysis.confidence as number | undefined;
  const valence = analysis.valence as number | undefined;
  const arousal = analysis.arousal as number | undefined;
  const eyeContact = analysis.eyeContact as string | undefined;
  const microExpressions = analysis.microExpressions as Array<{ type: string }> | undefined;

  if (dominantEmotion) {
    parts.push(`- Dominant emotion: ${dominantEmotion}${confidence ? ` (${Math.round(confidence * 100)}% confidence)` : ''}`);
  }
  if (typeof valence === 'number') {
    const valenceDesc = valence > 0.3 ? 'positive' : valence < -0.3 ? 'negative' : 'neutral';
    parts.push(`- Emotional valence: ${valenceDesc} (${valence.toFixed(2)})`);
  }
  if (typeof arousal === 'number') {
    const arousalDesc = arousal > 0.6 ? 'high' : arousal < 0.3 ? 'low' : 'moderate';
    parts.push(`- Arousal level: ${arousalDesc} (${arousal.toFixed(2)})`);
  }
  if (eyeContact) {
    parts.push(`- Eye contact: ${eyeContact}`);
  }
  if (microExpressions && microExpressions.length > 0) {
    const types = microExpressions.map(m => m.type || String(m));
    parts.push(`- Micro-expressions detected: ${types.join(', ')}`);
  }
  if (analysis.summary) {
    parts.push(`- Summary: ${analysis.summary}`);
  }

  return parts.join('\n');
}

/**
 * Format previous insights to prevent repetition
 */
export function formatPreviousInsights(
  insights: Array<{ type: string; content: string }>
): string {
  if (!insights || insights.length === 0) {
    return '';
  }

  const formatted = insights.map((i) => `- ${i.type}: ${i.content}`).join('\n');
  return `## Already Observed (DO NOT REPEAT these - find NEW angles):
${formatted}`;
}

/**
 * Create the context message for a user turn
 */
export function createTurnContext(
  userSpeech: string,
  bodyAnalysis: Parameters<typeof formatBodyContext>[0],
  faceAnalysis: Parameters<typeof formatFaceContext>[0],
  turnNumber: number,
  phase: string,
  previousInsights?: Array<{ type: string; content: string }>
): string {
  const bodyContext = formatBodyContext(bodyAnalysis);
  const faceContext = formatFaceContext(faceAnalysis);
  const insightsContext = formatPreviousInsights(previousInsights ?? []);

  return `[Turn ${turnNumber} - Phase: ${phase}]
${insightsContext ? '\n' + insightsContext + '\n' : ''}
${bodyContext}

${faceContext}

User said: "${userSpeech}"`;
}
