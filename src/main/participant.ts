/**
 * Claude-as-participant — the Conversation Tester (Shift+T → Conversation
 * tab) uses this module to generate the participant's next utterance
 * given the conversation so far. This replaces canned scripts so the
 * "participant" actually responds to whatever question Merlin asked,
 * instead of mechanically reading lines that may or may not be on-topic.
 *
 * Lives in the main process so the Anthropic SDK + API key stay
 * out of the renderer.
 */

import Anthropic from '@anthropic-ai/sdk';

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (client) return client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  client = new Anthropic({ apiKey: key });
  return client;
}

export function isParticipantLLMAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export interface ParticipantTurn {
  speaker: 'merlin' | 'participant';
  text: string;
}

export interface ParticipantRequest {
  /** Who they are — character description from the preset. */
  characterDescription: string;
  /** Optional richer profile fields the model can use for tone. */
  faceDescription?: string;
  bodyDescription?: string;
  /** Hint at the spell the character should eventually move toward. */
  expectedSpell?: { intent: string; element: string };
  /** Conversation so far. */
  history: ParticipantTurn[];
  /**
   * Force the model to produce a closing line ("speak the magic word")
   * — set by the runner on the second-to-last turn so the participant
   * winds down naturally toward casting.
   */
  closing?: boolean;
}

const SYSTEM_PROMPT = `You are an actor playing a participant in an interactive AR experience.
A wizard character ("Merlin") is asking you questions to shape a personalized spell.
Your job is to respond IN CHARACTER as the person you've been given, ONE short utterance at a time.

RULES:
- Speak as the character. First person, present tense. Don't narrate, don't describe yourself.
- ONE or TWO short sentences per response. People in real conversation don't monologue.
- ANSWER the question Merlin actually asked. Don't ignore it and switch topics.
- Stay grounded in the character's emotional state — the description tells you what's true for them right now.
- Don't be overly poetic unless that's the character. Real people say plain things.
- Don't analyze or explain your feelings academically. Show them through specifics: an image, a memory, a small detail.
- Don't acknowledge that you're an actor or that this is a test.
- Output ONLY the participant's words — no stage directions, no quotes around the line, no "they said:" prefix.`;

/**
 * Generate the next participant utterance. Returns null if the
 * Anthropic key isn't configured — caller should fall back to a canned
 * script line in that case.
 */
export async function generateParticipantLine(req: ParticipantRequest): Promise<string | null> {
  const c = getClient();
  if (!c) return null;

  const characterBlock = [
    `CHARACTER: ${req.characterDescription}`,
    req.faceDescription ? `Face/emotion: ${req.faceDescription}` : '',
    req.bodyDescription ? `Body/posture: ${req.bodyDescription}` : '',
    req.expectedSpell
      ? `Internal direction (where you'll eventually land — don't say this aloud, just lean toward it): ${req.expectedSpell.intent} / ${req.expectedSpell.element}`
      : '',
  ].filter(Boolean).join('\n');

  // Build a flat user-message transcript. Each Merlin line becomes
  // a "WIZARD:" prefix; each prior participant line becomes "YOU:"
  // so the model sees its own past utterances and can stay coherent.
  const transcriptLines = req.history.map(t =>
    t.speaker === 'merlin' ? `WIZARD: ${t.text}` : `YOU: ${t.text}`
  );

  const closingNote = req.closing
    ? '\n\nThis is your CLOSING TURN — the wizard has just told you the magic word and a gesture to perform. Respond very briefly (one short sentence) in a way that reads as you preparing to cast: a small acknowledgement, a held breath, a single line of intent. Do NOT say the magic word itself — that comes from a separate trigger.'
    : '';

  const userContent = [
    characterBlock,
    '',
    'CONVERSATION SO FAR:',
    transcriptLines.join('\n'),
    '',
    'Your next line, in character:' + closingNote,
  ].join('\n');

  try {
    const response = await c.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    // Strip incidental wrapping that the model sometimes adds despite
    // the prompt ("YOU: foo" or quote-wrapping).
    return text
      .replace(/^["']|["']$/g, '')
      .replace(/^(YOU|ME|PARTICIPANT)\s*:\s*/i, '')
      .trim();
  } catch (err) {
    console.error('[Participant] Claude call failed:', err);
    return null;
  }
}
