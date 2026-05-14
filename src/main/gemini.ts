/**
 * Gemini integration for one-shot multimodal analysis:
 *   - micro-expression filmstrip → JSON
 *   - body-language filmstrip → JSON
 *   - voice-command transcript → JSON
 *
 * These are independent of the Merlin spell-casting flow (which lives in
 * src/main/merlin/). Both paths use the @google/genai SDK; this module
 * does the simple stateless generateContent calls, merlin/* does the
 * stateful chat + tool dispatch.
 */

import { GoogleGenAI } from '@google/genai';
import type { MicroExpressionAnalysis, BodyLanguageAnalysis, VoiceCommandResult } from '../shared/types';

const MODEL = 'gemini-2.5-flash';

let genAI: GoogleGenAI | null = null;

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

const VOICE_COMMAND_PROMPT = `You are a voice command interpreter for Merlin, a motion capture application.
The user has spoken a command. Interpret what they want and respond with a JSON action.

Available commands and their actions:
- "start pose tracking" / "enable pose" / "turn on pose" → toggle_pose enabled:true
- "stop pose tracking" / "disable pose" / "turn off pose" → toggle_pose enabled:false
- "start face detection" / "enable face" / "turn on face" → toggle_face enabled:true
- "stop face detection" / "disable face" / "turn off face" → toggle_face enabled:false
- "start segmentation" / "enable segmentation" / "turn on segmentation" → toggle_segmentation enabled:true
- "stop segmentation" / "disable segmentation" / "turn off segmentation" → toggle_segmentation enabled:false
- "show pose overlay" / "show skeleton" → toggle_pose_overlay enabled:true
- "hide pose overlay" / "hide skeleton" → toggle_pose_overlay enabled:false
- "show face overlay" / "show face boxes" → toggle_face_overlay enabled:true
- "hide face overlay" / "hide face boxes" → toggle_face_overlay enabled:false
- "portrait mode" / "switch to portrait" → set_orientation portrait:true
- "landscape mode" / "switch to landscape" → set_orientation portrait:false
- "capture face" / "analyze face" / "read my expression" → capture_face
- "capture body" / "analyze body" / "read my body language" → capture_body
- "start auto face analysis" / "auto analyze face every X seconds" → start_auto_face (with optional intervalSeconds)
- "stop auto face analysis" → stop_auto_face
- "start auto body analysis" / "auto analyze body every X seconds" → start_auto_body (with optional intervalSeconds)
- "stop auto body analysis" → stop_auto_body
- "set face interval to X seconds" → set_face_interval seconds:X
- "set body interval to X seconds" → set_body_interval seconds:X

User said: "{transcript}"

Respond with ONLY valid JSON (no markdown, no code blocks):
{
  "understood": <true if you recognized a command, false otherwise>,
  "action": <the action object if understood, null otherwise>,
  "response": "<brief human-readable response to speak back>",
  "confidence": <0 to 1>
}

Examples:
User: "turn on pose tracking" → {"understood":true,"action":{"type":"toggle_pose","enabled":true},"response":"Pose tracking enabled","confidence":0.95}
User: "analyze my face" → {"understood":true,"action":{"type":"capture_face"},"response":"Capturing face expression","confidence":0.9}
User: "what's the weather" → {"understood":false,"action":null,"response":"I can only control Merlin features","confidence":0.8}`;

export function initGemini(): boolean {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('GEMINI_API_KEY not set - LLM analysis disabled');
    return false;
  }
  try {
    genAI = new GoogleGenAI({ apiKey });
    console.log(`Gemini initialized (${MODEL})`);
    return true;
  } catch (error) {
    console.error('Failed to initialize Gemini:', error);
    return false;
  }
}

export function isGeminiAvailable(): boolean {
  return genAI !== null;
}

function parseDataUrl(imageDataUrl: string): { mimeType: string; data: string } {
  const m = imageDataUrl.match(/^data:image\/(.*?);base64,(.*)$/);
  if (!m) throw new Error('Invalid image data URL');
  return { mimeType: `image/${m[1]}`, data: m[2] };
}

async function generateText(parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>): Promise<string> {
  if (!genAI) throw new Error('Gemini not initialized');
  const response = await genAI.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts }],
  });
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

export async function interpretVoiceCommand(transcript: string): Promise<VoiceCommandResult> {
  const prompt = VOICE_COMMAND_PROMPT.replace('{transcript}', transcript);
  try {
    const text = await generateText([{ text: prompt }]);
    let parsed: { understood?: boolean; action?: unknown; response?: string; confidence?: number };
    try {
      parsed = JSON.parse(extractJson(text));
    } catch {
      console.error('Failed to parse Gemini voice command response:', text);
      return {
        understood: false,
        action: null,
        response: "I didn't understand that command",
        confidence: 0,
      };
    }
    return {
      understood: parsed.understood ?? false,
      action: (parsed.action ?? null) as VoiceCommandResult['action'],
      response: parsed.response ?? 'Command processed',
      confidence: parsed.confidence ?? 0,
    };
  } catch (error) {
    console.error('Voice command interpretation error:', error);
    return {
      understood: false,
      action: null,
      response: `Error: ${error}`,
      confidence: 0,
    };
  }
}
