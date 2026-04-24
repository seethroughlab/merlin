/**
 * Gemini Integration for Expression Analysis
 *
 * Uses Google's Gemini 2.0 Flash for analyzing micro-expressions
 * from face strip images.
 */

import { GoogleGenerativeAI, Part } from '@google/generative-ai';
import type { MicroExpressionAnalysis, BodyLanguageAnalysis } from '../shared/types';

let genAI: GoogleGenerativeAI | null = null;
let model: any = null;

const BODY_LANGUAGE_PROMPT = `You are an expert in body language and nonverbal communication.
Analyze this filmstrip showing a person's skeleton/pose over approximately 5 seconds.

The skeleton frames are arranged left-to-right chronologically. Analyze:

POSTURE:
- Spine alignment (straight, hunched, leaning forward/back)
- Shoulder position (tense/raised, relaxed, asymmetric)
- Head position (tilted, forward, withdrawn)

GESTURES:
- Hand/arm movements (expansive, restrained, fidgeting)
- Self-touching behaviors (face, arms, neck)
- Barrier gestures (crossed arms, protective)

MOVEMENT PATTERNS:
- Overall stillness vs. activity level
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

/**
 * Initialize the Gemini client
 */
export function initGemini(): boolean {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.warn('GEMINI_API_KEY not set - LLM analysis disabled');
    return false;
  }

  try {
    genAI = new GoogleGenerativeAI(apiKey);
    model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    console.log('Gemini initialized (gemini-2.5-flash)');
    return true;
  } catch (error) {
    console.error('Failed to initialize Gemini:', error);
    return false;
  }
}

/**
 * Analyze a face strip image for micro-expressions
 */
export async function analyzeMicroExpressions(
  imageDataUrl: string
): Promise<MicroExpressionAnalysis> {
  if (!model) {
    throw new Error('Gemini not initialized');
  }

  // Extract base64 data from data URL
  const base64Match = imageDataUrl.match(/^data:image\/(.*?);base64,(.*)$/);
  if (!base64Match) {
    throw new Error('Invalid image data URL');
  }

  const mimeType = `image/${base64Match[1]}`;
  const base64Data = base64Match[2];

  // Create image part for Gemini
  const imagePart: Part = {
    inlineData: {
      mimeType,
      data: base64Data,
    },
  };

  try {
    const result = await model.generateContent([MICRO_EXPRESSION_PROMPT, imagePart]);
    const response = result.response;
    const text = response.text();

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('Failed to parse Gemini response:', text);
      throw new Error('Invalid response format from Gemini');
    }

    const analysis = JSON.parse(jsonMatch[0]) as MicroExpressionAnalysis;
    analysis.rawResponse = text;

    return analysis;
  } catch (error) {
    console.error('Gemini analysis error:', error);
    throw error;
  }
}

/**
 * Analyze a skeleton strip image for body language
 */
export async function analyzeBodyLanguage(
  imageDataUrl: string
): Promise<BodyLanguageAnalysis> {
  if (!model) {
    throw new Error('Gemini not initialized');
  }

  // Extract base64 data from data URL
  const base64Match = imageDataUrl.match(/^data:image\/(.*?);base64,(.*)$/);
  if (!base64Match) {
    throw new Error('Invalid image data URL');
  }

  const mimeType = `image/${base64Match[1]}`;
  const base64Data = base64Match[2];

  // Create image part for Gemini
  const imagePart: Part = {
    inlineData: {
      mimeType,
      data: base64Data,
    },
  };

  try {
    const result = await model.generateContent([BODY_LANGUAGE_PROMPT, imagePart]);
    const response = result.response;
    const text = response.text();

    // Parse JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('Failed to parse Gemini body language response:', text);
      throw new Error('Invalid response format from Gemini');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Ensure all required fields have valid values with defaults
    const analysis: BodyLanguageAnalysis = {
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

    return analysis;
  } catch (error) {
    console.error('Gemini body language analysis error:', error);
    throw error;
  }
}

/**
 * Check if Gemini is available
 */
export function isGeminiAvailable(): boolean {
  return model !== null;
}
