import { GoogleGenAI } from '@google/genai';
import type { MicroExpressionAnalysis, BodyLanguageAnalysis } from '../../shared/types';
import { withRetry } from '../retry';

const MODEL = 'gemini-3-flash-preview';

let genAI: GoogleGenAI | null = null;

function ensureGenAI(): GoogleGenAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');
    genAI = new GoogleGenAI({ apiKey });
  }
  return genAI;
}

export function isGeminiAvailable(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

const BODY_LANGUAGE_PROMPT = `You are an expert in body language and nonverbal communication.
Analyze this filmstrip showing a person over approximately 5 seconds.

Each frame is a real photo of the person (cropped to their body) with a
semi-transparent cyan skeleton overlay showing MediaPipe pose landmarks.
Read BOTH the photo (clothing, hand shape, facial cues, environment) AND
the skeleton (precise joint positions). Frames are arranged left-to-right
chronologically. Analyze:

POSTURE:
- Spine alignment (straight, hunched, leaning forward/back)
- Shoulder position (tense/raised, relaxed, asymmetric)
- Head position (tilted, forward, withdrawn)

GESTURES:
- Hand/arm movements (expansive, restrained, fidgeting)
- Self-touching behaviors (face, arms, neck)
- Barrier gestures (crossed arms, protective)
- Hand shape (open, clenched, pointing, holding something) — visible in
  the photo even though the skeleton only has wrist landmarks

MOVEMENT PATTERNS:
- Overall stillness vs. activity level (compare landmark positions
  between successive frames)
- Rhythmic movements (nodding, swaying)
- Sudden changes or reactions

ENGAGEMENT SIGNALS:
- Leaning toward/away
- Open vs. closed posture
- Comfort vs. discomfort indicators

Respond with ONLY valid JSON (no markdown, no code blocks):
{
  "openness": <-1 (closed/defensive) to 1 (open/engaged)>,
  "tension": <0 (relaxed) to 1 (tense)>,
  "engagement": <0 (disengaged) to 1 (highly engaged)>,
  "primaryPosture": "<dominant posture type>",
  "gestureTypes": ["<gesture1>", "<gesture2>"],
  "movementLevel": <0 (still) to 1 (active)>,
  "confidence": <0 to 1>,
  "observations": ["<key observation 1>", "<key observation 2>"],
  "description": "<1-2 sentence summary of body language>"
}`;

const MICRO_EXPRESSION_PROMPT = `You are an expert in micro-expression analysis and emotional intelligence.
Analyze the filmstrip of facial images showing a person's reaction over approximately 1 second.

The images are arranged left to right in chronological order, showing the progression of their emotional response.

Analyze the micro-expressions and emotional changes visible in this sequence. Look for:
- Subtle changes in facial muscles
- Eye movements and blinks
- Mouth micro-movements
- Eyebrow raises or furrows
- Signs of genuine vs. masked emotions

Respond with ONLY valid JSON in this exact format (no markdown, no code blocks):
{
  "valence": <number from -1 (very negative) to 1 (very positive)>,
  "arousal": <number from 0 (calm) to 1 (highly aroused/excited)>,
  "primaryEmotion": "<main emotion detected>",
  "secondaryEmotion": "<secondary emotion if present, or null>",
  "confidence": <number from 0 to 1>,
  "microExpressions": [
    {
      "type": "<type of micro-expression>",
      "timestamp": "<early|middle|late>",
      "intensity": <number from 0 to 1>
    }
  ],
  "description": "<brief 1-2 sentence narrative description of what you observed>"
}`;

function parseDataUrl(imageDataUrl: string): { mimeType: string; data: string } {
  const m = imageDataUrl.match(/^data:image\/(.*?);base64,(.*)$/);
  if (!m) throw new Error('Invalid image data URL');
  return { mimeType: `image/${m[1]}`, data: m[2] };
}

async function generateText(parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>): Promise<string> {
  const ai = ensureGenAI();
  const response = await withRetry(
    () => ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts }],
    }),
    { label: 'gemini:generateText' },
  );
  return response.text ?? '';
}

function extractJson(text: string): string {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Invalid response format from Gemini');
  return match[0];
}

export async function analyzeMicroExpressions(imageDataUrl: string): Promise<MicroExpressionAnalysis> {
  const { mimeType, data } = parseDataUrl(imageDataUrl);
  try {
    const text = await generateText([
      { text: MICRO_EXPRESSION_PROMPT },
      { inlineData: { mimeType, data } },
    ]);
    const analysis = JSON.parse(extractJson(text)) as MicroExpressionAnalysis;
    analysis.rawResponse = text;
    return analysis;
  } catch (error) {
    console.error('Gemini analysis error:', error);
    throw error;
  }
}

export async function analyzeBodyLanguage(imageDataUrl: string): Promise<BodyLanguageAnalysis> {
  const { mimeType, data } = parseDataUrl(imageDataUrl);
  try {
    const text = await generateText([
      { text: BODY_LANGUAGE_PROMPT },
      { inlineData: { mimeType, data } },
    ]);
    const parsed = JSON.parse(extractJson(text));
    return {
      openness: typeof parsed.openness === 'number' ? parsed.openness : 0,
      tension: typeof parsed.tension === 'number' ? parsed.tension : 0,
      engagement: typeof parsed.engagement === 'number' ? parsed.engagement : 0,
      primaryPosture: parsed.primaryPosture ?? 'unknown',
      gestureTypes: Array.isArray(parsed.gestureTypes) ? parsed.gestureTypes : [],
      movementLevel: typeof parsed.movementLevel === 'number' ? parsed.movementLevel : 0,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      observations: Array.isArray(parsed.observations) ? parsed.observations : [],
      description: parsed.description ?? 'No description available',
      rawResponse: text,
    };
  } catch (error) {
    console.error('Gemini body language analysis error:', error);
    throw error;
  }
}

